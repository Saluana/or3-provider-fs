/**
 * @module fs-storage-gateway-adapter
 *
 * StorageGatewayAdapter implementation backed by local filesystem.
 * Generates signed internal URLs for upload/download operations.
 */
import type { H3Event } from 'h3';
import { createError } from 'h3';
import { access, mkdir, readdir, rename, stat, unlink, writeFile, constants } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
    StorageGatewayAdapter,
    PresignUploadRequest,
    PresignUploadResponse,
    PresignDownloadRequest,
    PresignDownloadResponse,
} from '~~/server/storage/gateway/types';
import { requireCan } from '~~/server/auth/can';
import { resolveSessionContext } from '~~/server/auth/session';
import { getActiveSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { resolveFsUrlTtlSeconds } from './fs-config';
import { assertValidWorkspaceId, getFsObjectMetadataPath, resolveFsObjectPath, resolveFsWorkspacePath } from './fs-paths';
import { parseFsHash, parseFsStorageKey, requireFsHash } from './fs-hash';
import { signFsToken } from './fs-token';

interface FsGcInput {
    workspace_id: string;
    retention_seconds?: number;
    limit?: number;
}

function getStorageRootOrThrow(): string {
    const root = process.env.OR3_STORAGE_FS_ROOT;
    if (!root) {
        throw createError({ statusCode: 500, statusMessage: 'Storage root not configured' });
    }
    return root;
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function parseGcInput(input: unknown): { workspaceId: string; retentionSeconds: number; limit: number | undefined } {
    if (!input || typeof input !== 'object') {
        throw createError({ statusCode: 400, statusMessage: 'Invalid GC input' });
    }

    const body = input as FsGcInput;
    if (typeof body.workspace_id !== 'string' || body.workspace_id.length === 0) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid workspace_id' });
    }
    try {
        assertValidWorkspaceId(body.workspace_id);
    } catch {
        throw createError({ statusCode: 400, statusMessage: 'Invalid workspace_id' });
    }

    const retentionSeconds = body.retention_seconds ?? 30 * 24 * 3600;
    if (!Number.isFinite(retentionSeconds) || retentionSeconds < 0) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid retention_seconds' });
    }

    let limit: number | undefined;
    if (body.limit !== undefined) {
        if (!Number.isFinite(body.limit) || body.limit <= 0) {
            throw createError({ statusCode: 400, statusMessage: 'Invalid limit' });
        }
        limit = Math.floor(body.limit);
    }

    return {
        workspaceId: body.workspace_id,
        retentionSeconds: Math.floor(retentionSeconds),
        limit,
    };
}

async function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
    const files: string[] = [];
    const pending = [workspacePath];

    while (pending.length > 0) {
        const currentPath = pending.pop()!;
        const entries = await readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
                continue;
            }
            if (entry.isFile()) {
                files.push(entryPath);
            }
        }
    }

    return files;
}

function isDeletedFlag(value: unknown): boolean {
    return value === true || value === 1 || value === '1';
}

function isFileMetaDeleted(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const deleted = (payload as Record<string, unknown>).deleted;
    return isDeletedFlag(deleted);
}

async function resolveReferencedStorageKeys(event: H3Event, workspaceId: string): Promise<Set<string>> {
    const syncAdapter = getActiveSyncGatewayAdapter();
    if (!syncAdapter) {
        throw createError({ statusCode: 500, statusMessage: 'Sync adapter not configured' });
    }

    const referencedStorageKeys = new Set<string>();
    let cursor = 0;
    let hasMore = true;

    while (hasMore) {
        const pullResult = await syncAdapter.pull(event, {
            scope: { workspaceId },
            cursor,
            limit: 1000,
            tables: ['file_meta'],
        });

        for (const change of pullResult.changes) {
            if (change.tableName !== 'file_meta') continue;
            const parsedHash = parseFsHash(change.pk);
            if (!parsedHash) continue;

            if (change.op === 'delete' || isFileMetaDeleted(change.payload)) {
                referencedStorageKeys.delete(parsedHash.storageKey);
                continue;
            }

            referencedStorageKeys.add(parsedHash.storageKey);
        }

        cursor = pullResult.nextCursor;
        hasMore = pullResult.hasMore;
    }

    return referencedStorageKeys;
}

export class FsStorageGatewayAdapter implements StorageGatewayAdapter {
    id = 'fs';

    async presignUpload(
        event: H3Event,
        input: PresignUploadRequest,
    ): Promise<PresignUploadResponse> {
        requireFsHash(input.hash);

        const session = await resolveSessionContext(event);
        if (!session.authenticated || !session.user) {
            throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
        }
        requireCan(session, 'workspace.write', {
            kind: 'workspace',
            id: input.workspaceId,
        });

        const ttl = resolveFsUrlTtlSeconds();
        const token = signFsToken(
            {
                op: 'upload',
                workspace_id: input.workspaceId,
                user_id: session.user.id,
                hash: input.hash,
                mime_type: input.mimeType,
                size_bytes: input.sizeBytes,
            },
            ttl,
        );

        return {
            url: `/api/storage/fs/upload?token=${encodeURIComponent(token)}`,
            method: 'PUT',
            expiresAt: Date.now() + ttl * 1000,
            storageId: `${input.workspaceId}:${input.hash}`,
        };
    }

    async presignDownload(
        event: H3Event,
        input: PresignDownloadRequest,
    ): Promise<PresignDownloadResponse> {
        requireFsHash(input.hash);

        const session = await resolveSessionContext(event);
        if (!session.authenticated || !session.user) {
            throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
        }
        requireCan(session, 'workspace.read', {
            kind: 'workspace',
            id: input.workspaceId,
        });

        const ttl = resolveFsUrlTtlSeconds();
        const token = signFsToken(
            {
                op: 'download',
                workspace_id: input.workspaceId,
                user_id: session.user.id,
                hash: input.hash,
            },
            ttl,
        );

        return {
            url: `/api/storage/fs/download?token=${encodeURIComponent(token)}`,
            method: 'GET',
            expiresAt: Date.now() + ttl * 1000,
            storageId: `${input.workspaceId}:${input.hash}`,
        };
    }

    async commit(_event: H3Event, input: unknown): Promise<void> {
        if (!input || typeof input !== 'object') {
            throw createError({ statusCode: 400, statusMessage: 'Invalid commit input' });
        }

        const body = input as { workspace_id?: unknown; hash?: unknown };
        if (typeof body.workspace_id !== 'string' || typeof body.hash !== 'string') {
            throw createError({ statusCode: 400, statusMessage: 'Invalid commit input' });
        }

        const root = getStorageRootOrThrow();
        let objectPath: string;
        try {
            objectPath = resolveFsObjectPath(root, body.workspace_id, body.hash);
        } catch {
            throw createError({ statusCode: 400, statusMessage: 'Invalid path parameters' });
        }

        try {
            await access(objectPath, constants.F_OK);
        } catch {
            throw createError({ statusCode: 404, statusMessage: 'Uploaded file not found' });
        }

        const metadataPath = getFsObjectMetadataPath(objectPath);
        const metadata = JSON.stringify(
            {
                workspace_id: body.workspace_id,
                hash: body.hash,
                committed_at: new Date().toISOString(),
            },
            null,
            0,
        );

        const tempMetadataPath = `${metadataPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await mkdir(dirname(metadataPath), { recursive: true });
        await writeFile(tempMetadataPath, metadata, { encoding: 'utf8' });
        await rename(tempMetadataPath, metadataPath);
    }

    async gc(_event: H3Event, input: unknown): Promise<{ deleted_count: number }> {
        const { workspaceId, retentionSeconds, limit } = parseGcInput(input);
        const root = getStorageRootOrThrow();
        const cutoffMs = Date.now() - retentionSeconds * 1000;
        const maxDeletes = limit ?? Number.POSITIVE_INFINITY;
        const referencedStorageKeys = await resolveReferencedStorageKeys(_event, workspaceId);

        let deletedCount = 0;
        let workspacePath: string;
        try {
            workspacePath = resolveFsWorkspacePath(root, workspaceId);
        } catch {
            throw createError({ statusCode: 400, statusMessage: 'Invalid workspace_id' });
        }

        let files: string[];
        try {
            files = await listWorkspaceFiles(workspacePath);
        } catch {
            return { deleted_count: 0 };
        }

        for (const filePath of files) {
            if (deletedCount >= maxDeletes) break;
            const fileName = basename(filePath);
            const fileStats = await stat(filePath).catch(() => null);
            if (!fileStats) continue;
            if (fileStats.mtimeMs >= cutoffMs) continue;

            if (fileName.includes('.tmp-')) {
                if (await unlink(filePath).then(() => true).catch(() => false)) {
                    deletedCount += 1;
                }
                continue;
            }

            if (fileName.endsWith('.meta.json')) {
                const objectPath = filePath.slice(0, -'.meta.json'.length);
                const objectExists = await fileExists(objectPath);
                if (!objectExists) {
                    if (await unlink(filePath).then(() => true).catch(() => false)) {
                        deletedCount += 1;
                    }
                }
                continue;
            }

            const parsedStorageKey = parseFsStorageKey(fileName);
            if (!parsedStorageKey) continue;

            const metadataPath = getFsObjectMetadataPath(filePath);
            const isCommitted = await fileExists(metadataPath);
            if (!isCommitted) {
                if (await unlink(filePath).then(() => true).catch(() => false)) {
                    deletedCount += 1;
                }
                continue;
            }

            if (referencedStorageKeys.has(parsedStorageKey.storageKey)) {
                continue;
            }

            if (await unlink(filePath).then(() => true).catch(() => false)) {
                deletedCount += 1;
            }
            await unlink(metadataPath).catch(() => {});
        }

        return { deleted_count: deletedCount };
    }
}

export function createFsStorageGatewayAdapter(): FsStorageGatewayAdapter {
    return new FsStorageGatewayAdapter();
}

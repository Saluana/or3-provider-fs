/**
 * @module fs-storage-gateway-adapter
 *
 * StorageGatewayAdapter implementation backed by local filesystem.
 * Generates signed internal URLs for upload/download operations.
 */
import type { H3Event } from 'h3';
import { createError } from 'h3';
import type { Dirent } from 'node:fs';
import { access, mkdir, readdir, rename, stat, unlink, writeFile, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
    StorageGatewayAdapter,
    PresignUploadRequest,
    PresignUploadResponse,
    PresignDownloadRequest,
    PresignDownloadResponse,
} from '~~/server/storage/gateway/types';
import { requireCan } from '~~/server/auth/can';
import { resolveSessionContext } from '~~/server/auth/session';
import { resolveFsUrlTtlSeconds } from './fs-config';
import { assertValidWorkspaceId, getFsObjectMetadataPath, resolveFsObjectPath, resolveFsWorkspacePath } from './fs-paths';
import { requireFsHash } from './fs-hash';
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

        let deletedCount = 0;
        let workspacePath: string;
        try {
            workspacePath = resolveFsWorkspacePath(root, workspaceId);
        } catch {
            throw createError({ statusCode: 400, statusMessage: 'Invalid workspace_id' });
        }

        let entries: Dirent[];
        try {
            entries = await readdir(workspacePath, { withFileTypes: true });
        } catch {
            return { deleted_count: 0 };
        }

        for (const entry of entries) {
            if (deletedCount >= maxDeletes) break;
            if (!entry.isFile()) continue;

            const filePath = join(workspacePath, entry.name);
            const fileStats = await stat(filePath);
            if (fileStats.mtimeMs >= cutoffMs) continue;

            if (entry.name.includes('.tmp-')) {
                await unlink(filePath).catch(() => {});
                deletedCount += 1;
                continue;
            }

            if (entry.name.endsWith('.meta.json')) {
                const objectPath = filePath.slice(0, -'.meta.json'.length);
                const objectExists = await fileExists(objectPath);
                if (!objectExists) {
                    await unlink(filePath).catch(() => {});
                    deletedCount += 1;
                }
                continue;
            }

            const metadataPath = getFsObjectMetadataPath(filePath);
            const isCommitted = await fileExists(metadataPath);
            if (!isCommitted) {
                await unlink(filePath).catch(() => {});
                deletedCount += 1;
            }
        }

        return { deleted_count: deletedCount };
    }
}

export function createFsStorageGatewayAdapter(): FsStorageGatewayAdapter {
    return new FsStorageGatewayAdapter();
}

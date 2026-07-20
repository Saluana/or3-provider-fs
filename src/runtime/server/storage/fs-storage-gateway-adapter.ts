/**
 * @module fs-storage-gateway-adapter
 *
 * StorageGatewayAdapter implementation backed by local filesystem.
 * Generates signed internal URLs for upload/download operations.
 */
import type { H3Event } from 'h3';
import { createError } from 'h3';
import { access, mkdir, opendir, rename, stat, unlink, writeFile, constants } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
    StorageGatewayAdapter,
    PresignUploadRequest,
    PresignUploadResponse,
    PresignDownloadRequest,
    PresignDownloadResponse,
} from '~~/server/storage/gateway/types';
import type { CanonicalStorageQueryKind } from '~~/server/sync/gateway/types';
import { requireCan } from '~~/server/auth/can';
import { resolveSessionContext } from '~~/server/auth/session';
import { getActiveSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { resolveFsUrlTtlSeconds } from './fs-config';
import {
    assertValidWorkspaceId,
    getFsObjectMetadataPath,
    resolveFsObjectPath,
    resolveFsWorkspacePath,
} from './fs-paths';
import { parseFsStorageKey, requireFsHash } from './fs-hash';
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

    async gc(
        event: H3Event,
        input: unknown,
    ): Promise<{
        deleted_count: number;
        scanned_count?: number;
        status: 'completed' | 'disabled';
        reason?: 'canonical_reference_state_required';
    }> {
        const { workspaceId, retentionSeconds, limit = 100 } = parseGcInput(input);
        const sync = getActiveSyncGatewayAdapter();
        if (!sync?.queryCanonicalStorage) {
            return {
                deleted_count: 0,
                status: 'disabled',
                reason: 'canonical_reference_state_required',
            };
        }

        const hasCanonicalRecord = async (
            kind: Extract<CanonicalStorageQueryKind, 'live_metadata' | 'reference_edges'>,
            hash: string,
        ): Promise<boolean> => {
            let cursor: string | undefined;
            do {
                const page = await sync.queryCanonicalStorage!(event, {
                    scope: { workspaceId },
                    kind,
                    hash,
                    cursor,
                    limit: 100,
                });
                if (page.items.length > 0) return true;
                if (page.hasMore && !page.nextCursor) {
                    throw createError({
                        statusCode: 502,
                        statusMessage: 'Canonical storage provider returned an invalid page',
                    });
                }
                cursor = page.nextCursor;
            } while (cursor);
            return false;
        };

        const root = getStorageRootOrThrow();
        const workspacePath = resolveFsWorkspacePath(root, workspaceId);
        const cutoffMs = Date.now() - retentionSeconds * 1000;
        const candidates: Array<{ hash: string; objectPath: string; metadataPath: string }> = [];
        const scanLimit = Math.min(500, Math.max(limit, limit * 4));
        let scannedCount = 0;

        let directory;
        try {
            directory = await opendir(workspacePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { deleted_count: 0, scanned_count: 0, status: 'completed' };
            }
            throw error;
        }

        try {
            for await (const entry of directory) {
                if (!entry.isFile() || entry.name.endsWith('.meta.json')) continue;
                const parsed = parseFsStorageKey(entry.name);
                if (!parsed) continue;
                scannedCount += 1;
                const objectPath = resolveFsObjectPath(root, workspaceId, parsed.canonical);
                const info = await stat(objectPath);
                if (info.mtimeMs <= cutoffMs) {
                    candidates.push({
                        hash: parsed.canonical,
                        objectPath,
                        metadataPath: getFsObjectMetadataPath(objectPath),
                    });
                }
                if (candidates.length >= Math.min(limit, 500) || scannedCount >= scanLimit) break;
            }
        } finally {
            await directory.close().catch(() => undefined);
        }

        // Resolve every candidate before issuing the first delete. If the
        // canonical backend is unavailable, this run makes no destructive change.
        const unreferenced: typeof candidates = [];
        for (const candidate of candidates) {
            const hasMetadata = await hasCanonicalRecord('live_metadata', candidate.hash);
            const hasReference = hasMetadata
                ? true
                : await hasCanonicalRecord('reference_edges', candidate.hash);
            if (!hasMetadata && !hasReference) unreferenced.push(candidate);
        }

        let deletedCount = 0;
        for (const candidate of unreferenced) {
            // Recheck immediately before deletion so a reference created during
            // the initial scan wins over collection.
            if (await hasCanonicalRecord('live_metadata', candidate.hash)) continue;
            if (await hasCanonicalRecord('reference_edges', candidate.hash)) continue;
            await unlink(candidate.objectPath).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
            });
            await unlink(candidate.metadataPath).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
            });
            deletedCount += 1;
        }

        return {
            deleted_count: deletedCount,
            scanned_count: scannedCount,
            status: 'completed',
        };
    }
}

export function createFsStorageGatewayAdapter(): FsStorageGatewayAdapter {
    return new FsStorageGatewayAdapter();
}

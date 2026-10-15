/**
 * @module fs-storage-gateway-adapter
 *
 * StorageGatewayAdapter implementation backed by local filesystem.
 * Generates signed internal URLs for upload/download operations.
 */
import type { H3Event } from 'h3';
import { createError } from 'h3';
import { access, rename, unlink, writeFile, constants } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type {
    StorageGatewayAdapter,
    PresignUploadRequest,
    PresignUploadResponse,
    PresignDownloadRequest,
    PresignDownloadResponse,
    DeleteObjectRequest,
} from '~~/server/storage/gateway/types';
import { requireCan } from '~~/server/auth/can';
import { resolveSessionContext } from '~~/server/auth/session';
import { getActiveSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { resolveFsUrlTtlSeconds } from './fs-config';
import {
    assertValidWorkspaceId,
    getFsObjectMetadataPath,
    openFsObjectForDownload,
    resolveFsObjectPath,
} from './fs-paths';
import { requireFsHash } from './fs-hash';
import { signFsToken } from './fs-token';

const SAFE_INLINE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
]);

function normalizeDownloadMime(value: string | undefined): string {
    const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
    return normalized && SAFE_INLINE_MIME_TYPES.has(normalized)
        ? normalized
        : 'application/octet-stream';
}

function sanitizeDownloadFilename(value: string | undefined): string {
    const sanitized = (value ?? '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, '_')
        .replace(/[\\/]+/g, '_')
        .trim()
        .replace(/^\.+$/, '');
    return sanitized.slice(0, 180) || 'download';
}

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
        assertValidWorkspaceId(input.workspaceId);
        if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
            throw createError({ statusCode: 400, statusMessage: 'Upload size must be a nonnegative safe integer' });
        }

        const session = await resolveSessionContext(event);
        if (!session.authenticated || !session.user) {
            throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
        }
        requireCan(session, 'workspace.write', {
            kind: 'workspace',
            id: input.workspaceId,
        });

        const ttl = resolveFsUrlTtlSeconds();
        const expiresAt = Date.now() + ttl * 1000;
        const sync = getActiveSyncGatewayAdapter();
        const supportsIntents = Boolean(sync?.reserveUploadIntent && sync.consumeUploadIntent);
        if (!supportsIntents && (input.workspaceQuotaBytes !== undefined || sync?.reserveUploadIntent || sync?.consumeUploadIntent)) {
            throw createError({ statusCode: 503, statusMessage: 'Atomic upload quota reservations require sync-provider support' });
        }
        const intentId = supportsIntents ? randomUUID() : undefined;
        const mimeType = input.mimeType.split(';', 1)[0]!.trim().toLowerCase();
        if (intentId) {
            await sync!.reserveUploadIntent!(event, {
                intentId, workspaceId: input.workspaceId, hash: input.hash,
                mimeType, sizeBytes: input.sizeBytes, expiresAt: Math.floor(expiresAt / 1000),
                workspaceQuotaBytes: input.workspaceQuotaBytes,
            });
        }
        try {
            const token = signFsToken(
                {
                    op: 'upload',
                    workspace_id: input.workspaceId,
                    user_id: session.user.id,
                    hash: input.hash,
                    mime_type: mimeType,
                    size_bytes: input.sizeBytes,
                },
                ttl,
            );
            return {
                url: `/api/storage/fs/upload?token=${encodeURIComponent(token)}`,
                method: 'PUT', expiresAt, storageId: `${input.workspaceId}:${input.hash}`,
                ...(intentId ? { intentId } : {}),
            };
        } catch (error) {
            if (intentId && sync?.cancelUploadIntent) {
                await sync.cancelUploadIntent(event, { workspaceId: input.workspaceId, intentId }).catch(() => undefined);
            }
            throw error;
        }
    }

    async presignDownload(
        event: H3Event,
        input: PresignDownloadRequest,
    ): Promise<PresignDownloadResponse> {
        const parsedHash = requireFsHash(input.hash);

        const session = await resolveSessionContext(event);
        if (!session.authenticated || !session.user) {
            throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
        }
        requireCan(session, 'workspace.read', {
            kind: 'workspace',
            id: input.workspaceId,
        });

        const root = getStorageRootOrThrow();
        let objectPath: string;
        try {
            objectPath = resolveFsObjectPath(root, input.workspaceId, parsedHash.canonical);
        } catch {
            throw createError({ statusCode: 404, statusMessage: 'File not found' });
        }
        try {
            await access(objectPath, constants.F_OK);
            await access(getFsObjectMetadataPath(objectPath), constants.F_OK);
        } catch {
            // A blob without its commit sidecar is still a pending upload.
            throw createError({ statusCode: 404, statusMessage: 'File not found' });
        }

        const ttl = resolveFsUrlTtlSeconds();
        const token = signFsToken(
            {
                op: 'download',
                workspace_id: input.workspaceId,
                user_id: session.user.id,
                hash: parsedHash.canonical,
                mime_type: normalizeDownloadMime(input.mimeType),
                disposition:
                    normalizeDownloadMime(input.mimeType) === 'application/octet-stream'
                        ? 'attachment'
                        : input.disposition === 'attachment'
                            ? 'attachment'
                            : 'inline',
                filename: sanitizeDownloadFilename(input.filename),
            },
            ttl,
        );

        return {
            url: `/api/storage/fs/download?token=${encodeURIComponent(token)}`,
            method: 'GET',
            expiresAt: Date.now() + ttl * 1000,
            storageId: `${input.workspaceId}:${parsedHash.canonical}`,
        };
    }

    async commit(event: H3Event, input: unknown): Promise<void> {
        if (!input || typeof input !== 'object') {
            throw createError({ statusCode: 400, statusMessage: 'Invalid commit input' });
        }

        const body = input as Record<string, unknown>;
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

        const storageId = `${body.workspace_id}:${body.hash}`;
        if (body.storage_id !== undefined && body.storage_id !== storageId) {
            throw createError({ statusCode: 400, statusMessage: 'storage_id does not match expected filesystem object' });
        }
        const sync = getActiveSyncGatewayAdapter();
        const supportsIntents = Boolean(sync?.reserveUploadIntent && sync.consumeUploadIntent);
        if (!supportsIntents && (body.intent_id !== undefined || sync?.reserveUploadIntent || sync?.consumeUploadIntent)) {
            throw createError({ statusCode: 503, statusMessage: 'Upload intent consumption requires sync-provider support' });
        }
        if (supportsIntents && (
            typeof body.intent_id !== 'string' || !body.intent_id.trim() ||
            body.storage_id !== storageId ||
            typeof body.mime_type !== 'string' || !body.mime_type.trim() ||
            typeof body.size_bytes !== 'number' || !Number.isSafeInteger(body.size_bytes) || body.size_bytes < 0
        )) {
            throw createError({ statusCode: 400, statusMessage: 'Invalid upload intent commit' });
        }
        let size: number;
        try {
            const file = await openFsObjectForDownload(root, objectPath);
            try { size = (await file.stat()).size; } finally { await file.close(); }
        } catch {
            throw createError({ statusCode: 404, statusMessage: 'Uploaded file not found' });
        }
        if (body.size_bytes !== undefined && body.size_bytes !== size) {
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object size mismatch' });
        }
        const mimeType = typeof body.mime_type === 'string' ? body.mime_type.split(';', 1)[0]!.trim().toLowerCase() : undefined;
        // Consumption must succeed before publishing a new commit marker.
        // The sync backend accepts an exact consumed tuple again, so a local
        // sidecar write failure can be retried without freeing quota early.
        if (supportsIntents) {
            await sync!.consumeUploadIntent!(event, {
                intentId: body.intent_id as string, workspaceId: body.workspace_id,
                hash: body.hash, mimeType: mimeType!, sizeBytes: size, storageId,
            });
        }
        const metadataPath = getFsObjectMetadataPath(objectPath);
        const metadata = JSON.stringify({
            workspace_id: body.workspace_id, hash: body.hash, storage_id: storageId,
            committed_at: new Date().toISOString(), size_bytes: size, mime_type: mimeType,
            ...(supportsIntents ? { intent_id: body.intent_id } : {}),
        });
        const tempMetadataPath = `${metadataPath}.tmp-${randomUUID()}`;
        try {
            await writeFile(tempMetadataPath, metadata, { encoding: 'utf8', flag: 'wx' });
            await rename(tempMetadataPath, metadataPath);
        } finally {
            await unlink(tempMetadataPath).catch(() => undefined);
        }
    }

    async deleteObject(_event: H3Event, input: DeleteObjectRequest): Promise<void> {
        requireFsHash(input.hash);
        const expectedStorageId = `${input.workspaceId}:${input.hash}`;
        if (input.storageId !== undefined && input.storageId !== expectedStorageId) {
            throw createError({
                statusCode: 400,
                statusMessage: 'storage_id does not match expected filesystem object',
            });
        }

        const objectPath = resolveFsObjectPath(
            getStorageRootOrThrow(),
            input.workspaceId,
            input.hash,
        );
        const paths = [objectPath, getFsObjectMetadataPath(objectPath)];
        const present = await Promise.all(paths.map(path => access(path).then(() => true, error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
        })));
        if (!present.some(Boolean)) return;
        // An independent database query cannot coordinate a filesystem unlink
        // with other instances restoring metadata or adding references.
        throw createError({ statusCode: 503, statusMessage: 'Provider-owned deletion coordination is required' });
    }

    async gc(_event: H3Event, input: unknown): Promise<{
        deleted_count: number; status: 'disabled'; reason: 'deletion_coordination_required';
    }> {
        parseGcInput(input);
        return { deleted_count: 0, status: 'disabled', reason: 'deletion_coordination_required' };
    }
}

export function createFsStorageGatewayAdapter(): FsStorageGatewayAdapter {
    return new FsStorageGatewayAdapter();
}

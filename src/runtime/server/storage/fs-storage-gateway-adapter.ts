/**
 * @module fs-storage-gateway-adapter
 *
 * StorageGatewayAdapter implementation backed by local filesystem.
 * Generates signed internal URLs for upload/download operations.
 */
import type { H3Event } from 'h3';
import type {
    StorageGatewayAdapter,
    PresignUploadRequest,
    PresignUploadResponse,
    PresignDownloadRequest,
    PresignDownloadResponse,
} from '~~/server/storage/gateway/types';
import { signFsToken } from './fs-token';

export class FsStorageGatewayAdapter implements StorageGatewayAdapter {
    id = 'fs';

    async presignUpload(
        _event: H3Event,
        input: PresignUploadRequest,
    ): Promise<PresignUploadResponse> {
        const ttl = Number(process.env.OR3_STORAGE_FS_URL_TTL_SECONDS ?? 900);
        const token = signFsToken(
            {
                op: 'upload',
                workspace_id: input.workspaceId,
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
        _event: H3Event,
        input: PresignDownloadRequest,
    ): Promise<PresignDownloadResponse> {
        const ttl = Number(process.env.OR3_STORAGE_FS_URL_TTL_SECONDS ?? 900);
        const token = signFsToken(
            {
                op: 'download',
                workspace_id: input.workspaceId,
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

    async gc(_event: H3Event, _input: unknown): Promise<{ deleted_count: number }> {
        // v1 stub — deletion scan by retention + ref eligibility
        return { deleted_count: 0 };
    }
}

export function createFsStorageGatewayAdapter(): FsStorageGatewayAdapter {
    return new FsStorageGatewayAdapter();
}

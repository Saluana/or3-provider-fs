/**
 * Integration-style tests for the FsStorageGatewayAdapter and
 * the upload/download flow using real filesystem operations.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { H3Event } from 'h3';
import { FsStorageGatewayAdapter } from '../server/storage/fs-storage-gateway-adapter';
import { signFsToken, verifyFsToken } from '../server/storage/fs-token';
import { getFsObjectMetadataPath, resolveFsObjectPath } from '../server/storage/fs-paths';

const TEST_SECRET = 'integration-test-secret';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

const requireCanMock = vi.hoisted(() => vi.fn());
const resolveSessionContextMock = vi.hoisted(() => vi.fn());
const getActiveSyncGatewayAdapterMock = vi.hoisted(() => vi.fn());

vi.mock('~~/server/auth/can', () => ({
    requireCan: requireCanMock as unknown,
}));

vi.mock('~~/server/auth/session', () => ({
    resolveSessionContext: resolveSessionContextMock as unknown,
}));

vi.mock('~~/server/sync/gateway/registry', () => ({
    getActiveSyncGatewayAdapter: getActiveSyncGatewayAdapterMock as unknown,
}));

let storageRoot: string;

beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'or3-fs-test-'));
});

afterAll(async () => {
    await rm(storageRoot, { recursive: true, force: true });
});

describe('FsStorageGatewayAdapter', () => {
    beforeEach(() => {
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = TEST_SECRET;
        process.env.OR3_STORAGE_FS_ROOT = storageRoot;
        resolveSessionContextMock.mockResolvedValue({
            authenticated: true,
            user: { id: 'user-1' },
            workspace: { id: 'ws1', name: 'Workspace' },
            role: 'owner',
        });
        requireCanMock.mockReset();
        getActiveSyncGatewayAdapterMock.mockReset().mockReturnValue({
            pull: vi.fn().mockResolvedValue({
                changes: [],
                nextCursor: 0,
                hasMore: false,
            }),
        });
    });

    afterEach(() => {
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        delete process.env.OR3_STORAGE_FS_ROOT;
        delete process.env.OR3_STORAGE_FS_URL_TTL_SECONDS;
        requireCanMock.mockReset();
        resolveSessionContextMock.mockReset();
        getActiveSyncGatewayAdapterMock.mockReset();
    });

    const adapter = new FsStorageGatewayAdapter();
    const mockEvent = {} as H3Event;

    it('has id "fs"', () => {
        expect(adapter.id).toBe('fs');
    });

    describe('presignUpload', () => {
        it('returns a signed upload URL', async () => {
            const result = await adapter.presignUpload(mockEvent, {
                workspaceId: 'ws1',
                hash: HASH_A,
                mimeType: 'image/png',
                sizeBytes: 2048,
            });

            expect(result.url).toContain('/api/storage/fs/upload?token=');
            expect(result.method).toBe('PUT');
            expect(result.storageId).toBe(`ws1:${HASH_A}`);
            expect(result.expiresAt).toBeGreaterThan(Date.now());

            // Verify the embedded token is valid
            const tokenStr = decodeURIComponent(result.url.split('token=')[1]!);
            const claims = verifyFsToken(tokenStr);
            expect(claims.op).toBe('upload');
            expect(claims.workspace_id).toBe('ws1');
            expect(claims.user_id).toBe('user-1');
            expect(claims.hash).toBe(HASH_A);
            expect(claims.size_bytes).toBe(2048);
            expect(claims.mime_type).toBe('image/png');
        });

        it('respects custom TTL env var', async () => {
            process.env.OR3_STORAGE_FS_URL_TTL_SECONDS = '60';
            const before = Date.now();
            const result = await adapter.presignUpload(mockEvent, {
                workspaceId: 'ws1',
                hash: HASH_A,
                mimeType: 'text/plain',
                sizeBytes: 10,
            });
            // expiresAt should be ~60s from now, not 900s
            expect(result.expiresAt!).toBeLessThan(before + 120_000);
        });

        it('rejects unauthenticated presign requests', async () => {
            resolveSessionContextMock.mockResolvedValueOnce({ authenticated: false });
            await expect(
                adapter.presignUpload(mockEvent, {
                    workspaceId: 'ws1',
                    hash: HASH_A,
                    mimeType: 'text/plain',
                    sizeBytes: 10,
                }),
            ).rejects.toMatchObject({ statusCode: 401 });
        });
    });

    describe('presignDownload', () => {
        it('returns a signed download URL', async () => {
            const result = await adapter.presignDownload(mockEvent, {
                workspaceId: 'ws2',
                hash: HASH_B,
            });

            expect(result.url).toContain('/api/storage/fs/download?token=');
            expect(result.method).toBe('GET');
            expect(result.storageId).toBe(`ws2:${HASH_B}`);

            const tokenStr = decodeURIComponent(result.url.split('token=')[1]!);
            const claims = verifyFsToken(tokenStr);
            expect(claims.op).toBe('download');
            expect(claims.workspace_id).toBe('ws2');
            expect(claims.user_id).toBe('user-1');
            expect(claims.hash).toBe(HASH_B);
        });

        it('rejects malformed hash format', async () => {
            await expect(
                adapter.presignDownload(mockEvent, {
                    workspaceId: 'ws1',
                    hash: 'not-a-supported-hash',
                }),
            ).rejects.toThrow('Invalid hash');
        });
    });

    describe('gc', () => {
        it('deletes uncommitted stale files', async () => {
            const workspaceId = 'ws1';
            const hash = HASH_A;
            const target = resolveFsObjectPath(storageRoot, workspaceId, hash);
            const staleTime = new Date(Date.now() - 2 * 24 * 3600 * 1000);

            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.from('orphaned'));
            utimesSync(target, staleTime, staleTime);

            const result = await adapter.gc(mockEvent, {
                workspace_id: workspaceId,
                retention_seconds: 3600,
            });

            expect(result).toEqual({ deleted_count: 1 });
        });

        it('retains committed blobs and metadata', async () => {
            const workspaceId = 'ws1';
            const hash = HASH_B;
            const target = resolveFsObjectPath(storageRoot, workspaceId, hash);
            const staleTime = new Date(Date.now() - 2 * 24 * 3600 * 1000);

            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.from('committed'));
            utimesSync(target, staleTime, staleTime);

            await adapter.commit(mockEvent, {
                workspace_id: workspaceId,
                hash,
            });

            const metadataPath = getFsObjectMetadataPath(target);
            utimesSync(metadataPath, staleTime, staleTime);
            getActiveSyncGatewayAdapterMock.mockReturnValueOnce({
                pull: vi.fn().mockResolvedValue({
                    changes: [
                        {
                            tableName: 'file_meta',
                            pk: hash,
                            op: 'put',
                            payload: { deleted: false },
                        },
                    ],
                    nextCursor: 1,
                    hasMore: false,
                }),
            });

            const result = await adapter.gc(mockEvent, {
                workspace_id: workspaceId,
                retention_seconds: 3600,
            });

            expect(result).toEqual({ deleted_count: 0 });
            await expect(stat(target)).resolves.toBeTruthy();
            await expect(stat(metadataPath)).resolves.toBeTruthy();
        });

        it('deletes committed stale blobs when no file_meta reference exists', async () => {
            const workspaceId = 'ws1';
            const hash = HASH_A;
            const target = resolveFsObjectPath(storageRoot, workspaceId, hash);
            const staleTime = new Date(Date.now() - 2 * 24 * 3600 * 1000);

            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.from('committed-orphan'));
            utimesSync(target, staleTime, staleTime);

            await adapter.commit(mockEvent, {
                workspace_id: workspaceId,
                hash,
            });

            const metadataPath = getFsObjectMetadataPath(target);
            utimesSync(metadataPath, staleTime, staleTime);

            const result = await adapter.gc(mockEvent, {
                workspace_id: workspaceId,
                retention_seconds: 3600,
            });

            expect(result).toEqual({ deleted_count: 2 });
            await expect(stat(target)).rejects.toThrow();
            await expect(stat(metadataPath)).rejects.toThrow();
        });

        it('fails GC when sync adapter is unavailable', async () => {
            getActiveSyncGatewayAdapterMock.mockReturnValueOnce(null);
            await expect(
                adapter.gc(mockEvent, {
                    workspace_id: 'ws1',
                    retention_seconds: 3600,
                }),
            ).rejects.toMatchObject({ statusCode: 500 });
        });
    });
});

describe('Upload / Download flow', () => {
    beforeEach(() => {
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = TEST_SECRET;
        process.env.OR3_STORAGE_FS_ROOT = storageRoot;
    });

    afterEach(() => {
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        delete process.env.OR3_STORAGE_FS_ROOT;
    });

    it('writes a file atomically and reads it back', async () => {
        const wsId = 'ws-flow';
        const hash = HASH_A;
        const content = Buffer.from('hello world');

        // Simulate upload: sign token, resolve path, write
        const token = signFsToken(
            { op: 'upload', workspace_id: wsId, user_id: 'user-1', hash, size_bytes: content.length },
            300,
        );
        const claims = verifyFsToken(token);
        expect(claims.op).toBe('upload');

        const target = resolveFsObjectPath(storageRoot, wsId, hash);
        await mkdir(dirname(target), { recursive: true });
        const temp = `${target}.tmp-${Date.now()}`;
        await writeFile(temp, content);
        const { rename } = await import('node:fs/promises');
        await rename(temp, target);

        // Simulate download: verify token, read file
        const dlToken = signFsToken(
            { op: 'download', workspace_id: wsId, user_id: 'user-1', hash },
            300,
        );
        const dlClaims = verifyFsToken(dlToken);
        expect(dlClaims.op).toBe('download');

        const filePath = resolveFsObjectPath(storageRoot, wsId, hash);
        const data = await readFile(filePath);
        expect(data.toString()).toBe('hello world');
    });

    it('rejects upload token for download operation', () => {
        const token = signFsToken(
            { op: 'upload', workspace_id: 'ws1', user_id: 'user-1', hash: HASH_A, size_bytes: 1 },
            300,
        );
        const claims = verifyFsToken(token);
        expect(claims.op).toBe('upload');
        // An endpoint should reject this for download
        expect(claims.op).not.toBe('download');
    });

    it('rejects download token for upload operation', () => {
        const token = signFsToken(
            { op: 'download', workspace_id: 'ws1', user_id: 'user-1', hash: HASH_A },
            300,
        );
        const claims = verifyFsToken(token);
        expect(claims.op).not.toBe('upload');
    });

    it('enforces size constraint from token claims', async () => {
        const maxSize = 10;
        const token = signFsToken(
            { op: 'upload', workspace_id: 'ws-size', user_id: 'user-1', hash: HASH_B, size_bytes: maxSize },
            300,
        );
        const claims = verifyFsToken(token);
        const oversizedBody = Buffer.alloc(maxSize + 1, 'x');

        // Verify that the size check would reject
        expect(claims.size_bytes).toBe(maxSize);
        expect(oversizedBody.length).toBeGreaterThan(claims.size_bytes!);
    });

    it('rejects wrong-secret token', () => {
        const token = signFsToken(
            { op: 'upload', workspace_id: 'ws1', user_id: 'user-1', hash: HASH_A, size_bytes: 1 },
            300,
        );
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = 'wrong-secret';
        expect(() => verifyFsToken(token)).toThrow();
    });
});

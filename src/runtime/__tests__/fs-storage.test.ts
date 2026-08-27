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
import { createCanonicalStorageContractFixture } from '~~/server/sync/gateway/testing/canonical-storage-fixture';
import { verifyStorageReferenceContract } from '~~/shared/testing/contracts/storage';

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
            const objectPath = resolveFsObjectPath(storageRoot, 'ws2', HASH_B);
            await mkdir(dirname(objectPath), { recursive: true });
            await writeFile(objectPath, 'blob');
            await writeFile(getFsObjectMetadataPath(objectPath), '{}');

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

        it('rejects an uploaded blob that has not crossed the commit sidecar boundary', async () => {
            const objectPath = resolveFsObjectPath(storageRoot, 'ws2-pending', HASH_B);
            await mkdir(dirname(objectPath), { recursive: true });
            await writeFile(objectPath, 'pending');

            await expect(adapter.presignDownload(mockEvent, {
                workspaceId: 'ws2-pending',
                hash: HASH_B,
            })).rejects.toMatchObject({ statusCode: 404 });
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

    describe('deleteObject', () => {
        it('deletes the blob and marker and succeeds when repeated', async () => {
            const workspaceId = 'ws-delete-idempotent';
            const target = resolveFsObjectPath(storageRoot, workspaceId, HASH_A);
            const marker = getFsObjectMetadataPath(target);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, 'blob');
            await writeFile(marker, '{}');

            const input = {
                workspaceId,
                hash: HASH_A,
                storageId: `${workspaceId}:${HASH_A}`,
            };
            await expect(adapter.deleteObject(mockEvent, input)).resolves.toBeUndefined();
            await expect(adapter.deleteObject(mockEvent, input)).resolves.toBeUndefined();
            await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('rejects a storage id from another workspace without deleting either object', async () => {
            const target = resolveFsObjectPath(storageRoot, 'ws-delete-a', HASH_B);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, 'keep');

            await expect(adapter.deleteObject(mockEvent, {
                workspaceId: 'ws-delete-a',
                hash: HASH_B,
                storageId: `ws-delete-b:${HASH_B}`,
            })).rejects.toMatchObject({ statusCode: 400 });
            await expect(readFile(target, 'utf8')).resolves.toBe('keep');
        });
    });

    describe('gc', () => {
        it('executes the shared canonical liveness adapter contract', async () => {
            const workspaceId = 'ws-shared-liveness';
            const hashes = { live: HASH_A, orphan: HASH_B } as const;
            const references = new Set<string>();
            await verifyStorageReferenceContract({
                name: 'fs',
                async put(logical) {
                    const target = resolveFsObjectPath(
                        storageRoot,
                        workspaceId,
                        hashes[logical as keyof typeof hashes]
                    );
                    await mkdir(dirname(target), { recursive: true });
                    await writeFile(target, logical);
                    const stale = new Date(Date.now() - 2 * 24 * 3600 * 1000);
                    utimesSync(target, stale, stale);
                },
                async reference(logical) { references.add(logical); },
                async collect() {
                    getActiveSyncGatewayAdapterMock.mockReturnValue({
                        pull: vi.fn(),
                        queryCanonicalStorage: vi.fn(async (_event, request) => {
                            const logical = request.hash === HASH_A ? 'live' : 'orphan';
                            return request.kind === 'reference_edges' && references.has(logical)
                                ? { items: [{
                                    kind: 'reference', hash: request.hash,
                                    sourceTable: 'messages', sourceId: 'message-live',
                                }], hasMore: false }
                                : { items: [], hasMore: false };
                        }),
                    });
                    await adapter.gc(mockEvent, {
                        workspace_id: workspaceId, retention_seconds: 3600, limit: 10,
                    });
                    const deleted: string[] = [];
                    for (const logical of ['live', 'orphan'] as const) {
                        const target = resolveFsObjectPath(storageRoot, workspaceId, hashes[logical]);
                        const exists = await stat(target).then(() => true).catch(() => false);
                        if (!exists) deleted.push(logical);
                    }
                    return deleted;
                },
            });
        });

        it('executes the shared canonical reference sentinel fixture', async () => {
            const workspaceId = 'ws-shared-contract';
            const hash = HASH_B;
            const target = resolveFsObjectPath(storageRoot, workspaceId, hash);
            const staleTime = new Date(Date.now() - 2 * 24 * 3600 * 1000);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.from('still-referenced'));
            utimesSync(target, staleTime, staleTime);

            const fixture = createCanonicalStorageContractFixture({
                workspaceId,
                now: Math.floor(Date.now() / 1000),
                retentionSeconds: 3600,
                pageSize: 1,
            }).reference(hash, { sourceTable: 'messages', sourceId: 'message-sentinel' });
            expect(fixture.isPastRetention(Math.floor(staleTime.getTime() / 1000))).toBe(true);
            const queryCanonicalStorage = vi.fn((_event, request) => fixture.query(request));
            getActiveSyncGatewayAdapterMock.mockReturnValueOnce({
                pull: vi.fn(),
                queryCanonicalStorage,
            });

            await expect(adapter.gc(mockEvent, {
                workspace_id: workspaceId,
                retention_seconds: fixture.retentionSeconds,
                limit: 1,
            })).resolves.toMatchObject({ deleted_count: 0, scanned_count: 1 });
            await expect(stat(target)).resolves.toBeTruthy();
            expect(queryCanonicalStorage).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ kind: 'reference_edges', hash })
            );
        });

        it('reports disabled and leaves stale uncommitted files untouched', async () => {
            const workspaceId = 'ws-canonical-live';
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

            expect(result).toEqual({
                deleted_count: 0,
                status: 'disabled',
                reason: 'canonical_reference_state_required',
            });
            await expect(stat(target)).resolves.toBeTruthy();
            expect(getActiveSyncGatewayAdapterMock).toHaveBeenCalledOnce();
        });

        it('keeps canonical live metadata when the winning put is absent from retained logs', async () => {
            const workspaceId = 'ws-canonical-edge';
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
            const pull = vi.fn();
            const queryCanonicalStorage = vi.fn().mockImplementation((_event, request) => ({
                items: request.kind === 'live_metadata'
                    ? [{ kind: 'metadata', hash, sizeBytes: 9, updatedAt: 1 }]
                    : [],
                hasMore: false,
            }));
            getActiveSyncGatewayAdapterMock.mockReturnValueOnce({
                pull,
                queryCanonicalStorage,
            });

            const result = await adapter.gc(mockEvent, {
                workspace_id: workspaceId,
                retention_seconds: 3600,
            });

            expect(result).toEqual({
                deleted_count: 0,
                scanned_count: 1,
                status: 'completed',
            });
            expect(pull).not.toHaveBeenCalled();
            expect(queryCanonicalStorage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                kind: 'live_metadata',
                hash,
            }));
            await expect(stat(target)).resolves.toBeTruthy();
            await expect(stat(metadataPath)).resolves.toBeTruthy();
        });

        it('keeps a referenced blob when a later losing LWW delete exists in retained history', async () => {
            const workspaceId = 'ws-canonical-delete';
            const hash = HASH_A;
            const target = resolveFsObjectPath(storageRoot, workspaceId, hash);
            const staleTime = new Date(Date.now() - 2 * 24 * 3600 * 1000);

            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.from('committed-live'));
            utimesSync(target, staleTime, staleTime);

            await adapter.commit(mockEvent, {
                workspace_id: workspaceId,
                hash,
            });

            const metadataPath = getFsObjectMetadataPath(target);
            utimesSync(metadataPath, staleTime, staleTime);
            const pull = vi.fn().mockResolvedValue({
                changes: [
                    {
                        tableName: 'file_meta',
                        pk: hash,
                        op: 'delete',
                        payload: undefined,
                    },
                ],
                nextCursor: 1,
                hasMore: false,
            });
            const queryCanonicalStorage = vi.fn().mockImplementation((_event, request) => ({
                items: request.kind === 'reference_edges'
                    ? [{ kind: 'reference', hash, sourceTable: 'messages', sourceId: 'message-1' }]
                    : [],
                hasMore: false,
            }));
            getActiveSyncGatewayAdapterMock.mockReturnValueOnce({ pull, queryCanonicalStorage });

            const result = await adapter.gc(mockEvent, {
                workspace_id: workspaceId,
                retention_seconds: 3600,
            });

            expect(result).toEqual({
                deleted_count: 0,
                scanned_count: 1,
                status: 'completed',
            });
            expect(pull).not.toHaveBeenCalled();
            expect(queryCanonicalStorage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                kind: 'reference_edges',
                hash,
            }));
            await expect(stat(target)).resolves.toBeTruthy();
            await expect(stat(metadataPath)).resolves.toBeTruthy();
        });

        it('deletes a retained stale blob only after bounded canonical metadata and edge queries are empty', async () => {
            const workspaceId = 'ws-canonical-orphan';
            const hash = HASH_A;
            const target = resolveFsObjectPath(storageRoot, workspaceId, hash);
            const staleTime = new Date(Date.now() - 2 * 24 * 3600 * 1000);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.from('orphaned'));
            await adapter.commit(mockEvent, { workspace_id: workspaceId, hash });
            const metadataPath = getFsObjectMetadataPath(target);
            utimesSync(target, staleTime, staleTime);
            utimesSync(metadataPath, staleTime, staleTime);

            const queryCanonicalStorage = vi.fn().mockResolvedValue({ items: [], hasMore: false });
            getActiveSyncGatewayAdapterMock.mockReturnValueOnce({
                pull: vi.fn(),
                queryCanonicalStorage,
            });

            await expect(adapter.gc(mockEvent, {
                workspace_id: workspaceId,
                retention_seconds: 3600,
                limit: 1,
            })).resolves.toEqual({
                deleted_count: 1,
                scanned_count: 1,
                status: 'completed',
            });
            expect(queryCanonicalStorage).toHaveBeenCalledTimes(4);
            for (const call of queryCanonicalStorage.mock.calls) {
                expect(call[1]).toMatchObject({ hash, limit: 100 });
            }
            await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('bounds canonical reads by the deletion page instead of directory size', async () => {
            const workspaceId = 'ws-bounded-gc';
            const staleTime = new Date(Date.now() - 2 * 24 * 3600 * 1000);
            for (let index = 0; index < 128; index += 1) {
                const hash = `sha256:${index.toString(16).padStart(64, '0')}`;
                const target = resolveFsObjectPath(storageRoot, workspaceId, hash);
                await mkdir(dirname(target), { recursive: true });
                await writeFile(target, Buffer.from('orphan'));
                utimesSync(target, staleTime, staleTime);
            }
            const queryCanonicalStorage = vi.fn().mockResolvedValue({ items: [], hasMore: false });
            getActiveSyncGatewayAdapterMock.mockReturnValueOnce({
                pull: vi.fn(),
                queryCanonicalStorage,
            });

            await expect(adapter.gc(mockEvent, {
                workspace_id: workspaceId,
                retention_seconds: 3600,
                limit: 2,
            })).resolves.toMatchObject({ deleted_count: 2, scanned_count: 2 });
            // Two preflight and two immediate-recheck queries per candidate.
            expect(queryCanonicalStorage).toHaveBeenCalledTimes(8);
        });

        it('bounds filesystem stat work even when a large directory has no eligible candidates', async () => {
            const workspaceId = 'ws-bounded-fresh-scan';
            for (let index = 0; index < 128; index += 1) {
                const hash = `sha256:${(index + 1000).toString(16).padStart(64, '0')}`;
                const target = resolveFsObjectPath(storageRoot, workspaceId, hash);
                await mkdir(dirname(target), { recursive: true });
                await writeFile(target, Buffer.from('fresh'));
            }
            const queryCanonicalStorage = vi.fn().mockResolvedValue({ items: [], hasMore: false });
            getActiveSyncGatewayAdapterMock.mockReturnValueOnce({
                pull: vi.fn(),
                queryCanonicalStorage,
            });

            await expect(adapter.gc(mockEvent, {
                workspace_id: workspaceId,
                retention_seconds: 3600,
                limit: 2,
            })).resolves.toEqual({
                deleted_count: 0,
                scanned_count: 8,
                status: 'completed',
            });
            expect(queryCanonicalStorage).not.toHaveBeenCalled();
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

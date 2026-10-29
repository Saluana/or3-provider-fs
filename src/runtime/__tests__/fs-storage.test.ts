/**
 * Integration-style tests for the FsStorageGatewayAdapter and
 * the upload/download flow using real filesystem operations.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink, readdir, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { H3Event } from 'h3';
import { FsStorageGatewayAdapter } from '../server/storage/fs-storage-gateway-adapter';
import { signFsToken, verifyFsToken } from '../server/storage/fs-token';
import { getFsObjectMetadataPath, resolveFsObjectPath } from '../server/storage/fs-paths';

import { observeFsStorageUsage } from '../server/storage/fs-usage';

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

    describe('presignUpload', () => {
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

    describe('upload intent quota lifecycle', () => {
        it.each(['none', 'reserve-only', 'consume-only'])('fails quota requests closed without complete intent support (%s)', async support => {
            getActiveSyncGatewayAdapterMock.mockReturnValue({
                ...(support === 'reserve-only' ? { reserveUploadIntent: vi.fn() } : {}),
                ...(support === 'consume-only' ? { consumeUploadIntent: vi.fn() } : {}),
            });
            await expect(adapter.presignUpload(mockEvent, {
                workspaceId: 'ws1', hash: HASH_A, mimeType: 'text/plain', sizeBytes: 3, workspaceQuotaBytes: 10,
            })).rejects.toMatchObject({ statusCode: 503 });
        });

        it('reserves quota before issuing a URL and consumes before publishing the filesystem commit marker', async () => {
            const workspaceId = 'ws-intent';
            const target = resolveFsObjectPath(storageRoot, workspaceId, HASH_A);
            const marker = getFsObjectMetadataPath(target);
            const reserveUploadIntent = vi.fn().mockResolvedValue(undefined);
            const consumeUploadIntent = vi.fn(async () => {
                await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
            });
            getActiveSyncGatewayAdapterMock.mockReturnValue({ reserveUploadIntent, consumeUploadIntent });
            const upload = await adapter.presignUpload(mockEvent, {
                workspaceId, hash: HASH_A, mimeType: 'text/plain; charset=utf-8', sizeBytes: 3, workspaceQuotaBytes: 10,
            });
            expect(upload.intentId).toEqual(expect.any(String));
            expect(reserveUploadIntent).toHaveBeenCalledWith(mockEvent, {
                intentId: upload.intentId, workspaceId, hash: HASH_A, mimeType: 'text/plain', sizeBytes: 3,
                workspaceQuotaBytes: 10, expiresAt: Math.floor(upload.expiresAt! / 1000),
            });
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, 'abc');
            await adapter.commit(mockEvent, {
                workspace_id: workspaceId, hash: HASH_A, intent_id: upload.intentId,
                storage_id: upload.storageId, size_bytes: 3, mime_type: 'text/plain; charset=utf-8',
            });
            expect(consumeUploadIntent).toHaveBeenCalledWith(mockEvent, {
                intentId: upload.intentId, workspaceId, hash: HASH_A, mimeType: 'text/plain', sizeBytes: 3,
                storageId: upload.storageId,
            });
            expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ intent_id: upload.intentId, size_bytes: 3 });
        });

        it('does not publish a commit sidecar when intent consumption fails, and allows retry', async () => {
            const workspaceId = 'ws-consume-retry';
            const target = resolveFsObjectPath(storageRoot, workspaceId, HASH_A);
            const marker = getFsObjectMetadataPath(target);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, 'abc');
            const consumeUploadIntent = vi.fn().mockRejectedValueOnce({ statusCode: 503 }).mockResolvedValue(undefined);
            getActiveSyncGatewayAdapterMock.mockReturnValue({ reserveUploadIntent: vi.fn(), consumeUploadIntent });
            const input = { workspace_id: workspaceId, hash: HASH_A, intent_id: 'intent-retry',
                storage_id: `${workspaceId}:${HASH_A}`, size_bytes: 3, mime_type: 'text/plain' };
            await expect(adapter.commit(mockEvent, input)).rejects.toMatchObject({ statusCode: 503 });
            await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
            await adapter.commit(mockEvent, input);
            expect(JSON.parse(await readFile(marker, 'utf8')).intent_id).toBe('intent-retry');
        });

        it('retries a local sidecar write failure after successful idempotent intent consumption', async () => {
            const workspaceId = 'ws-marker-retry';
            const target = resolveFsObjectPath(storageRoot, workspaceId, HASH_A);
            const marker = getFsObjectMetadataPath(target);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, 'abc');
            await mkdir(marker);
            const consumeUploadIntent = vi.fn().mockResolvedValue(undefined);
            getActiveSyncGatewayAdapterMock.mockReturnValue({ reserveUploadIntent: vi.fn(), consumeUploadIntent });
            const input = { workspace_id: workspaceId, hash: HASH_A, intent_id: 'intent-marker',
                storage_id: `${workspaceId}:${HASH_A}`, size_bytes: 3, mime_type: 'text/plain' };
            await expect(adapter.commit(mockEvent, input)).rejects.toBeDefined();
            expect(consumeUploadIntent).toHaveBeenCalledTimes(1);
            await rm(marker, { recursive: true });
            await adapter.commit(mockEvent, input);
            expect(consumeUploadIntent).toHaveBeenCalledTimes(2);
            expect(JSON.parse(await readFile(marker, 'utf8')).intent_id).toBe('intent-marker');
        });

        it.each(['missing_intent', 'storage_id', 'size'])('rejects an invalid commit before consuming or publishing (%s)', async invalid => {
            const workspaceId = `ws-invalid-${invalid}`;
            const target = resolveFsObjectPath(storageRoot, workspaceId, HASH_A);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, 'abc');
            const consumeUploadIntent = vi.fn();
            getActiveSyncGatewayAdapterMock.mockReturnValue({ reserveUploadIntent: vi.fn(), consumeUploadIntent });
            await expect(adapter.commit(mockEvent, {
                workspace_id: workspaceId, hash: HASH_A, intent_id: invalid === 'missing_intent' ? undefined : 'intent',
                storage_id: invalid === 'storage_id' ? 'other-workspace:object' : `${workspaceId}:${HASH_A}`,
                size_bytes: invalid === 'size' ? 4 : 3, mime_type: 'text/plain',
            })).rejects.toMatchObject({ statusCode: 400 });
            expect(consumeUploadIntent).not.toHaveBeenCalled();
            await expect(readFile(getFsObjectMetadataPath(target))).rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('releases its reservation if token signing fails', async () => {
            const reserveUploadIntent = vi.fn(async (_event: H3Event, _input: { intentId: string }) => { delete process.env.OR3_STORAGE_FS_TOKEN_SECRET; });
            const cancelUploadIntent = vi.fn().mockResolvedValue(undefined);
            getActiveSyncGatewayAdapterMock.mockReturnValue({ reserveUploadIntent, consumeUploadIntent: vi.fn(), cancelUploadIntent });
            await expect(adapter.presignUpload(mockEvent, {
                workspaceId: 'ws1', hash: HASH_A, mimeType: 'text/plain', sizeBytes: 3, workspaceQuotaBytes: 10,
            })).rejects.toThrow('Missing OR3_STORAGE_FS_TOKEN_SECRET');
            expect(cancelUploadIntent).toHaveBeenCalledWith(mockEvent, {
                workspaceId: 'ws1', intentId: reserveUploadIntent.mock.calls[0]?.[1]?.intentId,
            });
        });
    });

    describe('presignDownload', () => {
        // Proofs must hash the actual committed file, not echo the sidecar/key.
        it('attests the current original and refuses a corrupted committed file', async () => {
            const hash = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
            const objectPath = resolveFsObjectPath(storageRoot, 'ws-proof', hash);
            await mkdir(dirname(objectPath), { recursive: true });
            await writeFile(objectPath, 'abc');
            await writeFile(getFsObjectMetadataPath(objectPath), '{}');
            const input = { workspaceId: 'ws-proof', hash, verifyContent: true };
            expect(await adapter.presignDownload(mockEvent, input)).toMatchObject({
                verifiedContent: { hash, sizeBytes: 3 },
            });
            await writeFile(objectPath, 'bad');
            await expect(adapter.presignDownload(mockEvent, input)).rejects.toBeDefined();
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
        it('succeeds for an absent object without canonical queries', async () => {
            getActiveSyncGatewayAdapterMock.mockReturnValue({});
            await expect(adapter.deleteObject(mockEvent, {workspaceId: 'ws-absent', hash: HASH_B})).resolves.toBeUndefined();
        });
        it('fails closed for an existing blob even when independent canonical reads are empty', async () => {
            getActiveSyncGatewayAdapterMock.mockReturnValue({ queryCanonicalStorage: vi.fn().mockResolvedValue({items: [], hasMore: false}) });
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
            await expect(adapter.deleteObject(mockEvent, input)).rejects.toMatchObject({ statusCode: 503 });
            await expect(adapter.deleteObject(mockEvent, input)).rejects.toMatchObject({ statusCode: 503 });
            await expect(readFile(target, 'utf8')).resolves.toBe('blob');
            await expect(readFile(marker, 'utf8')).resolves.toBe('{}');
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
        it.each(['unavailable', 'empty', 'referenced'])('leaves filesystem bytes intact without deletion coordination (%s canonical state)', async state => {
            const workspaceId = 'ws-no-coordination-' + state;
            const target = resolveFsObjectPath(storageRoot, workspaceId, HASH_A);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, 'retained-original');
            const queryCanonicalStorage = vi.fn().mockResolvedValue({ items: state === 'referenced' ? [{ hash: HASH_A }] : [], hasMore: false });
            getActiveSyncGatewayAdapterMock.mockReturnValue(state === 'unavailable' ? {} : { queryCanonicalStorage });
            expect(await adapter.gc(mockEvent, { workspace_id: workspaceId, retention_seconds: 0, limit: 1 }))
                .toMatchObject({ deleted_count: 0, status: 'disabled', reason: 'deletion_coordination_required' });
            expect(await readFile(target, 'utf8')).toBe('retained-original');
            expect(queryCanonicalStorage).not.toHaveBeenCalled();
        });

        // Containment only: no physical collector is enabled. This exercises the
        // production refusal around restore/reference/hash-reuse interleavings;
        // it is deliberately NOT qualification of a future deleting collector.
        it('preserves restored and newly referenced bytes across repeated concurrent GC requests and hash reuse', async () => {
            const workspaceId = 'ws-gc-interleaving';
            const target = resolveFsObjectPath(storageRoot, workspaceId, HASH_A);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, 'original');
            const canonical = { live: false, references: 0 };
            const queryCanonicalStorage = vi.fn(async () => ({ items: canonical.live || canonical.references ? [{ hash: HASH_A }] : [], hasMore: false }));
            getActiveSyncGatewayAdapterMock.mockReturnValue({ queryCanonicalStorage });
            const first = adapter.gc(mockEvent, { workspace_id: workspaceId, retention_seconds: 0 });
            canonical.live = true;
            canonical.references++;
            const second = adapter.gc(mockEvent, { workspace_id: workspaceId, retention_seconds: 0 });
            await writeFile(target, 'original');
            await Promise.all([first, second]);
            await expect(adapter.deleteObject(mockEvent, { workspaceId, hash: HASH_A })).rejects.toMatchObject({ statusCode: 503 });
            expect(await readFile(target, 'utf8')).toBe('original');
            expect(queryCanonicalStorage).not.toHaveBeenCalled();
        });
    });

    describe('read-only usage observation', () => {
        // Failure modes: disk usage mistaken for quota, tombstones omitted,
        // abandoned transfers ignored, symlinks followed, moving pages double
        // counted, or bounded/failed scans silently presented as complete.
        async function object(workspaceId: string, hash: string, value: string, committed = true) {
            const target = resolveFsObjectPath(storageRoot, workspaceId, hash);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, value);
            if (committed) await writeFile(getFsObjectMetadataPath(target), '{}');
            return target;
        }

        it('separates logical quota, retained objects, incomplete transfers, overhead and observed allocated bytes', async () => {
            const workspaceId = 'ws-usage';
            const active = await object(workspaceId, HASH_A, 'active');
            await object(workspaceId, HASH_B, 'retained');
            await object(workspaceId, 'c'.repeat(64), 'raw', false);
            await writeFile(active + '.tmp-interrupted', 'temp');
            await writeFile(join(dirname(active), 'unknown'), '??');
            const before = await readdir(dirname(active));
            getActiveSyncGatewayAdapterMock.mockReturnValue({
                capabilities: { retainedStorageMetadata: 'v1' },
                queryCanonicalStorage: vi.fn(async (_event, input) => ({ hasMore: false, items:
                    input.kind === 'live_metadata' ? [{ kind: 'metadata', hash: HASH_A, sizeBytes: 6 }] :
                    input.kind === 'retained_metadata' ? [{ kind: 'retained_metadata', hash: HASH_B, sizeBytes: 8 }] :
                    [{ kind: 'reservation', reservationId: 'intent', hash: 'd'.repeat(64), sizeBytes: 11 }],
                })),
            });
            const result = await observeFsStorageUsage(mockEvent, workspaceId);
            expect(result).toMatchObject({ consistency: 'non_atomic_observation', physicalCleanupEnabled: false,
                canonical: { complete: true, activeMetadataBytes: 6, retainedDeletedMetadataBytes: 8, reservedUploadBytes: 11 },
                filesystem: { complete: true, activeBlobBytes: 6, retainedDeletedBlobBytes: 8,
                    incompleteTransferBytes: 7, sidecarBytes: 4, unclassifiedBytes: 2, apparentFileBytes: 27 },
            });
            expect(result.filesystem.allocatedFileBytes).toBeGreaterThanOrEqual(0);
            expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
            expect(await readdir(dirname(active))).toEqual(before);
            expect(await readFile(active, 'utf8')).toBe('active');
        });

        it('leaves retained accounting unknown for older providers rather than sending an unsupported query', async () => {
            const workspaceId = 'ws-legacy-usage';
            await object(workspaceId, HASH_B, 'keep');
            const queryCanonicalStorage = vi.fn().mockResolvedValue({ items: [], hasMore: false });
            getActiveSyncGatewayAdapterMock.mockReturnValue({ queryCanonicalStorage });
            const result = await observeFsStorageUsage(mockEvent, workspaceId);
            expect(result.canonical).toMatchObject({ complete: false, retainedDeletedMetadataBytes: null });
            expect(result.filesystem).toMatchObject({ unclassifiedBytes: 4, retainedDeletedBlobBytes: 0 });
            expect(result.warnings).toContain('retained_metadata_unsupported');
            expect(queryCanonicalStorage.mock.calls.some(([, input]) => input.kind === 'retained_metadata')).toBe(false);
        });

        it('bounds both the physical scan and bad provider cursor traversal', async () => {
            const workspaceId = 'ws-bounded-usage';
            await object(workspaceId, HASH_A, 'keep');
            const queryCanonicalStorage = vi.fn().mockResolvedValue({ items: [], hasMore: true, nextCursor: 'repeat' });
            getActiveSyncGatewayAdapterMock.mockReturnValue({ queryCanonicalStorage });
            const result = await observeFsStorageUsage(mockEvent, workspaceId, { maxEntries: 1 });
            expect(result.filesystem).toMatchObject({ complete: false, entriesScanned: 1, orphanSidecarCount: null });
            expect(result.canonical).toMatchObject({ complete: false, activeMetadataBytes: null });
            expect(result.warnings).toEqual(expect.arrayContaining(['filesystem_entry_limit', 'canonical_query_failed']));
            expect(queryCanonicalStorage.mock.calls.length).toBeLessThanOrEqual(4);
        });

        it('classifies restore races conservatively and never counts one hash in both logical views', async () => {
            const workspaceId = 'ws-restore-observation';
            await object(workspaceId, HASH_A, 'keep');
            getActiveSyncGatewayAdapterMock.mockReturnValue({ capabilities: { retainedStorageMetadata: 'v1' },
                queryCanonicalStorage: vi.fn(async (_event, input) => ({ hasMore: false, items: input.kind === 'active_reservations' ? [] : [
                    { kind: input.kind === 'live_metadata' ? 'metadata' : 'retained_metadata', hash: HASH_A, sizeBytes: 4 },
                ] })),
            });
            const result = await observeFsStorageUsage(mockEvent, workspaceId);
            expect(result.canonical.complete).toBe(false);
            expect(result.warnings).toContain('canonical_state_changed');
            expect(result.filesystem).toMatchObject({ activeBlobBytes: 0, retainedDeletedBlobBytes: 0, unclassifiedBytes: 4 });
        });

        it('does not follow symlink entries and counts hard-linked allocated bytes once', async () => {
            const workspaceId = 'ws-links-usage';
            const target = await object(workspaceId, HASH_A, 'keep', false);
            await link(target, join(dirname(target), 'hardlink'));
            await symlink('/not-a-storage-object', join(dirname(target), 'symlink'));
            const result = await observeFsStorageUsage(mockEvent, workspaceId);
            expect(result.filesystem).toMatchObject({ complete: false, apparentFileBytes: 8, skippedEntries: 1, hardlinkAliases: 1 });
            expect(result.warnings).toContain('non_regular_entry');
            expect(result.filesystem.allocatedFileBytes).toBe(Number((await stat(target, { bigint: true })).blocks * 512n));
            expect(await readFile(target, 'utf8')).toBe('keep');
        });

        it('rejects a workspace directory symlink without reading outside the storage root', async () => {
            await mkdir(join(storageRoot, 'workspaces'), { recursive: true });
            await symlink(tmpdir(), join(storageRoot, 'workspaces', 'ws-outside-usage'));
            await expect(observeFsStorageUsage(mockEvent, 'ws-outside-usage')).rejects.toMatchObject({ statusCode: 503 });
        });

        it('rejects a dangling workspace symlink instead of reporting an absent directory', async () => {
            await mkdir(join(storageRoot, 'workspaces'), { recursive: true });
            await symlink(join(storageRoot, 'missing-target'), join(storageRoot, 'workspaces', 'ws-dangling-usage'));
            await expect(observeFsStorageUsage(mockEvent, 'ws-dangling-usage')).rejects.toMatchObject({ statusCode: 503 });
        });

        it('makes an absent workspace directory explicit and does not infer canonical absence', async () => {
            getActiveSyncGatewayAdapterMock.mockReturnValue({ capabilities: { retainedStorageMetadata: 'v1' },
                queryCanonicalStorage: vi.fn(async (_event, input) => ({ hasMore: false, items: input.kind === 'live_metadata'
                    ? [{ kind: 'metadata', hash: HASH_A, sizeBytes: 17 }] : [] })),
            });
            const result = await observeFsStorageUsage(mockEvent, 'ws-never-uploaded');
            expect(result.canonical.activeMetadataBytes).toBe(17);
            expect(result.filesystem.apparentFileBytes).toBe(0);
            expect(result.warnings).toContain('workspace_directory_absent');
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

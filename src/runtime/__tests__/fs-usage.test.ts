// Kept separate from fs-storage.test.ts to isolate filesystem fault injection
// from the existing real-filesystem upload/download integration coverage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { H3Event } from 'h3';
import { observeFsStorageUsage } from '../server/storage/fs-usage';

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    authorize: vi.fn(),
    opendir: vi.fn(),
    open: vi.fn(),
}));
vi.mock('~~/server/auth/can', () => ({ requireCan: mocks.authorize }));
vi.mock('~~/server/auth/session', () => ({ resolveSessionContext: vi.fn().mockResolvedValue({ authenticated: true }) }));
vi.mock('~~/server/sync/gateway/registry', () => ({ getActiveSyncGatewayAdapter: () => ({
    capabilities: { retainedStorageMetadata: 'v1' }, queryCanonicalStorage: mocks.query,
}) }));
vi.mock('node:fs/promises', async importOriginal => ({
    ...await importOriginal<typeof import('node:fs/promises')>(),
    opendir: mocks.opendir,
    open: mocks.open,
}));

const event = {} as H3Event;
const hashA = 'sha256:' + 'a'.repeat(64);
const hashB = 'sha256:' + 'b'.repeat(64);
let root: string;
let workspace: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'or3-usage-review-'));
    workspace = join(root, 'workspaces', 'owner');
    await mkdir(workspace, { recursive: true });
    process.env.OR3_STORAGE_FS_ROOT = root;
    mocks.authorize.mockReset();
    mocks.query.mockReset().mockResolvedValue({ items: [], hasMore: false });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    mocks.opendir.mockReset().mockImplementation(actual.opendir);
    mocks.open.mockReset().mockImplementation(actual.open);
});

afterEach(async () => {
    delete process.env.OR3_STORAGE_FS_ROOT;
    await rm(root, { recursive: true, force: true });
});

describe('storage observation failure boundaries', () => {
    it('rejects unauthorized observation before touching canonical state', async () => {
        mocks.authorize.mockImplementationOnce(() => { throw new Error('Forbidden'); });
        await expect(observeFsStorageUsage(event, 'owner')).rejects.toThrow('Forbidden');
        expect(mocks.query).not.toHaveBeenCalled();
        expect(mocks.opendir).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, 50_001, NaN, Infinity])('rejects an invalid bound %s', async maxEntries => {
        await expect(observeFsStorageUsage(event, 'owner', { maxEntries })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects a reused reservation identity whose hash changes without a size change', async () => {
        mocks.query.mockImplementation(async (_event, input) => ({ hasMore: false, items: input.kind === 'active_reservations' ? [
            { kind: 'reservation', reservationId: 'same-intent', hash: hashA, sizeBytes: 4 },
            { kind: 'reservation', reservationId: 'same-intent', hash: hashB, sizeBytes: 4 },
        ] : [] }));
        const result = await observeFsStorageUsage(event, 'owner');
        expect(result.canonical).toMatchObject({ complete: false, reservedUploadBytes: null });
        expect(result.warnings).toContain('canonical_query_failed');
    });

    it('refuses conflicting metadata sizes without publishing a partial sum', async () => {
        mocks.query.mockImplementation(async (_event, input) => ({ hasMore: false, items: input.kind === 'live_metadata' ? [
            { kind: 'metadata', hash: hashA, sizeBytes: 4 },
            { kind: 'metadata', hash: hashA, sizeBytes: 5 },
        ] : [] }));
        const result = await observeFsStorageUsage(event, 'owner');
        expect(result.canonical).toMatchObject({ complete: false, activeMetadataBytes: null });
    });

    it('deduplicates stable repeated canonical records across pages', async () => {
        mocks.query.mockImplementation(async (_event, input) => ({
            hasMore: input.kind === 'live_metadata' && !input.cursor,
            nextCursor: input.kind === 'live_metadata' && !input.cursor ? 'next' : undefined,
            items: input.kind === 'live_metadata' ? [{ kind: 'metadata', hash: hashA, sizeBytes: 4 }] : [],
        }));
        const result = await observeFsStorageUsage(event, 'owner');
        expect(result.canonical).toMatchObject({ complete: true, activeMetadataBytes: 4, recordsScanned: 2 });
    });

    it('limits canonical records without scanning an extra record or starting another view', async () => {
        mocks.query.mockResolvedValue({ hasMore: true, nextCursor: 'more', items: [
            { kind: 'metadata', hash: hashA, sizeBytes: 4 },
        ] });
        const result = await observeFsStorageUsage(event, 'owner', { maxMetadataRecords: 1 });
        expect(result.canonical).toMatchObject({ complete: false, recordsScanned: 1, activeMetadataBytes: null });
        expect(mocks.query).toHaveBeenCalledTimes(1);
        expect(mocks.query.mock.calls[0]?.[1].limit).toBe(1);
        expect(result.warnings).toContain('canonical_record_limit');
    });

    it('keeps delete-before-put retained sizes unknown', async () => {
        mocks.query.mockImplementation(async (_event, input) => ({ hasMore: false, items: input.kind === 'retained_metadata' ? [
            { kind: 'retained_metadata', hash: hashA },
        ] : [] }));
        const result = await observeFsStorageUsage(event, 'owner');
        expect(result.canonical).toMatchObject({ complete: false, retainedDeletedMetadataBytes: null, unknownRetainedSizeCount: 1 });
        expect(result.warnings).toContain('retained_metadata_size_unknown');
    });

    it('rejects an intermediate directory symlink into another in-root directory', async () => {
        await rename(join(root, 'workspaces'), join(root, 'other'));
        await symlink(join(root, 'other'), join(root, 'workspaces'));
        await expect(observeFsStorageUsage(event, 'owner')).rejects.toMatchObject({ statusCode: 503 });
        expect(mocks.query).not.toHaveBeenCalled();
    });

    it('does not traverse a workspace swapped to another workspace during canonical queries', async () => {
        const neighbor = join(root, 'workspaces', 'neighbor');
        await mkdir(neighbor);
        await writeFile(join(neighbor, 'private-name'), 'neighbor-private-data');
        mocks.query.mockImplementationOnce(async () => {
            await rename(workspace, workspace + '-previous');
            await symlink(neighbor, workspace);
            return { items: [], hasMore: false };
        });
        const result = await observeFsStorageUsage(event, 'owner');
        expect(result.filesystem).toMatchObject({ complete: false, apparentFileBytes: 0, orphanSidecarCount: null });
        expect(result.warnings).toContain('filesystem_directory_unreadable_or_changed');
    });

    it('pins directory enumeration and file opens even when the workspace is replaced at opendir', async () => {
        const neighbor = join(root, 'workspaces', 'neighbor');
        await mkdir(neighbor);
        await writeFile(join(workspace, 'own-file'), 'mine');
        await writeFile(join(neighbor, 'own-file'), 'neighbor-private-data');
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        mocks.opendir.mockImplementationOnce(async path => {
            await rename(workspace, workspace + '-previous');
            await symlink(neighbor, workspace);
            return actual.opendir(path);
        });
        const result = await observeFsStorageUsage(event, 'owner');
        expect(result.filesystem.apparentFileBytes).toBe(4);
    });

    it('returns explicit partial accounting when opening a directory fails', async () => {
        mocks.opendir.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
        const result = await observeFsStorageUsage(event, 'owner');
        expect(result.filesystem).toMatchObject({ complete: false, apparentFileBytes: 0, orphanSidecarCount: null });
        expect(result.warnings).toContain('filesystem_directory_unreadable_or_changed');
    });

    it('preserves observed totals and reports partial accounting on a mid-enumeration failure', async () => {
        await writeFile(join(workspace, 'own-file'), 'mine');
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        mocks.opendir.mockImplementationOnce(async path => {
            const directory = await actual.opendir(path);
            return { async *[Symbol.asyncIterator]() {
                for await (const entry of directory) {
                    yield entry;
                    throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
                }
            } };
        });
        const result = await observeFsStorageUsage(event, 'owner');
        expect(result.filesystem).toMatchObject({ complete: false, apparentFileBytes: 4, orphanSidecarCount: null });
        expect(result.warnings).toContain('filesystem_directory_unreadable_or_changed');
    });

    it('keeps valid apparent bytes when allocation statistics cannot be represented safely', async () => {
        await writeFile(join(workspace, 'own-file'), 'mine');
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        mocks.open.mockImplementation(async (path, flags) => {
            const handle = await actual.open(path, flags);
            if (String(path).endsWith('/own-file')) {
                const file = await handle.stat({ bigint: true });
                return {
                    stat: async () => Object.assign(file, { blocks: BigInt(Number.MAX_SAFE_INTEGER) }),
                    close: () => handle.close(),
                };
            }
            return handle;
        });
        const result = await observeFsStorageUsage(event, 'owner');
        expect(result.filesystem).toMatchObject({ complete: true, apparentFileBytes: 4, allocatedFileBytes: null, skippedEntries: 0 });
        expect(result.warnings).toContain('allocated_bytes_unavailable');
    });
});

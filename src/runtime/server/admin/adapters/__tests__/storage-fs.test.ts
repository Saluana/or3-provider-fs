import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsStorageAdminAdapter } from '../storage-fs';
import type { ProviderActionContext } from '~~/server/admin/providers/types';

const getActiveSyncGatewayAdapterMock = vi.hoisted(() => vi.fn());
vi.mock('~~/server/sync/gateway/registry', () => ({
    getActiveSyncGatewayAdapter: getActiveSyncGatewayAdapterMock,
}));

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const context = { session: { workspace: { id: 'ws1' } } } as ProviderActionContext;
let root: string;

async function observe(payload?: Record<string, unknown>) {
    return await fsStorageAdminAdapter.runAction!({} as H3Event, 'storage.usage', payload, context) as {
        consistency: string;
        startedAt: string;
        completedAt: string;
        canonical: {
            activeMetadataBytes: number | null;
            retainedDeletedMetadataBytes: number | null;
            reservedUploadBytes: number | null;
            complete: { activeMetadata: boolean; retainedDeletedMetadata: boolean; reservedUploads: boolean };
        };
        filesystem: {
            complete: boolean;
            apparentFileBytes: number | null;
            allocatedFileBytes: number | null;
            categories: Record<string, { files: number; apparentBytes: number | null }>;
        };
        volume: { totalBytes: number | null; availableBytes: number | null } | null;
        warnings: string[];
    };
}

function useCanonical(items: Record<string, unknown[]>, retained = true) {
    const query = vi.fn(async (_event, input) => ({ items: items[input.kind] ?? [], hasMore: false }));
    getActiveSyncGatewayAdapterMock.mockReturnValue({
        capabilities: retained ? { retainedStorageMetadata: 'v1' } : {},
        queryCanonicalStorage: query,
    });
    return query;
}

describe('fsStorageAdminAdapter', () => {
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'or3-fs-admin-'));
        await mkdir(join(root, 'workspaces', 'ws1'), { recursive: true });
        getActiveSyncGatewayAdapterMock.mockReset().mockReturnValue({ pull: vi.fn() });
        process.env.OR3_STORAGE_FS_ROOT = root;
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = 'x'.repeat(32);
        (globalThis as typeof globalThis & { useRuntimeConfig?: unknown }).useRuntimeConfig = () => ({
            auth: { enabled: true, strict: false },
            storage: { enabled: true, provider: 'fs' },
            public: { auth: { enabled: true }, storage: { enabled: true, provider: 'fs' } },
        });
    });

    afterEach(async () => {
        delete process.env.OR3_STORAGE_FS_ROOT;
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        await rm(root, { recursive: true, force: true });
    });

    it.each([false, true])('reports disabled GC matching the action result (canonical queries: %s)', async queries => {
        if (queries) useCanonical({});
        const result = await fsStorageAdminAdapter.getStatus({} as H3Event, { enabled: true, provider: 'fs' });
        expect(result.details).toMatchObject({ gcStatus: 'disabled', gcDisabledReason: 'deletion_coordination_required' });
        expect(result.actions).toContainEqual(expect.objectContaining({ id: 'storage.gc', label: 'Check Storage GC Status' }));
        expect(result.actions).toContainEqual(expect.objectContaining({ id: 'storage.usage', label: 'Observe Storage Usage' }));
        expect(await fsStorageAdminAdapter.runAction!({} as H3Event, 'storage.gc', undefined, context))
            .toMatchObject({ deleted_count: 0, status: 'disabled', reason: 'deletion_coordination_required' });
    });

    it('observes canonical usage and actual file categories without changing retained bytes', async () => {
        const query = useCanonical({
            live_metadata: [{ kind: 'metadata', hash: HASH_A, sizeBytes: 3, storageId: `ws1:${HASH_A}` }],
            retained_metadata: [{ kind: 'retained_metadata', hash: HASH_B, sizeBytes: 7, storageId: `ws1:${HASH_B}` }],
            active_reservations: [{ kind: 'reservation', reservationId: 'intent-1', hash: HASH_C, sizeBytes: 11, expiresAt: Math.floor(Date.now() / 1000) + 60 }],
        });
        const workspace = join(root, 'workspaces', 'ws1');
        await writeFile(join(workspace, `sha256_${'a'.repeat(64)}`), 'abc');
        await writeFile(join(workspace, `sha256_${'b'.repeat(64)}`), 'deleted');
        await writeFile(join(workspace, `sha256_${'b'.repeat(64)}.meta.json`), '{}');
        await writeFile(join(workspace, `sha256_${'c'.repeat(64)}.tmp-1-123`), 'half');
        await writeFile(join(workspace, 'unrecognized'), 'other');
        const result = await observe();
        expect(result).toMatchObject({
            consistency: 'non_atomic_observation',
            canonical: { activeMetadataBytes: 3, retainedDeletedMetadataBytes: 7, reservedUploadBytes: 11,
                complete: { activeMetadata: true, retainedDeletedMetadata: true, reservedUploads: true } },
            filesystem: { complete: true, apparentFileBytes: 21, categories: {
                activeBlobs: { files: 1, apparentBytes: 3 }, retainedDeletedBlobs: { files: 1, apparentBytes: 7 },
                incompleteTransfers: { files: 1, apparentBytes: 4 }, sidecars: { files: 1, apparentBytes: 2 },
                unclassifiedFiles: { files: 1, apparentBytes: 5 },
            } },
        });
        expect(Date.parse(result.completedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
        expect(result.volume?.totalBytes).toBeGreaterThan(0);
        expect(query.mock.calls.every(([, input]) => input.scope.workspaceId === 'ws1')).toBe(true);
        expect(new Set(query.mock.calls.map(([, input]) => input.now)).size).toBe(1);
        expect(await readFile(join(workspace, `sha256_${'b'.repeat(64)}`), 'utf8')).toBe('deleted');
    });

    it('keeps missing or foreign storage identities unclassified even when their content hash matches', async () => {
        useCanonical({
            live_metadata: [
                { kind: 'metadata', hash: HASH_A, sizeBytes: 3 },
                { kind: 'metadata', hash: HASH_C, sizeBytes: 3, storageId: `other-workspace:${HASH_C}` },
            ],
            retained_metadata: [{ kind: 'retained_metadata', hash: HASH_B, sizeBytes: 3, storageId: `s3/workspaces/ws1/${HASH_B}` }],
        });
        const workspace = join(root, 'workspaces', 'ws1');
        for (const hex of ['a', 'b', 'c']) await writeFile(join(workspace, `sha256_${hex.repeat(64)}`), 'abc');
        const result = await observe();
        expect(result.canonical).toMatchObject({ activeMetadataBytes: 6, retainedDeletedMetadataBytes: 3 });
        expect(result.filesystem.categories).toMatchObject({ activeBlobs: { files: 0 }, retainedDeletedBlobs: { files: 0 }, unclassifiedFiles: { files: 3, apparentBytes: 9 } });
        expect(result.warnings).toContain('canonical_live_metadata_storage_identity_unknown');
        expect(result.warnings).toContain('canonical_live_metadata_storage_identity_mismatch');
        expect(result.warnings).toContain('canonical_retained_metadata_storage_identity_mismatch');
    });

    it('leaves retained accounting unknown for older sync providers without probing unsupported queries', async () => {
        const query = useCanonical({}, false);
        const result = await observe();
        expect(result.canonical.retainedDeletedMetadataBytes).toBeNull();
        expect(result.canonical.complete.retainedDeletedMetadata).toBe(false);
        expect(query.mock.calls.some(([, input]) => input.kind === 'retained_metadata')).toBe(false);
        expect(result.warnings).toContain('canonical_retained_metadata_unsupported');
    });

    it('preserves unknown deleted sizes and ambiguity instead of inventing zero or active blob ownership', async () => {
        useCanonical({
            live_metadata: [{ kind: 'metadata', hash: HASH_A, sizeBytes: 3 }],
            retained_metadata: [{ kind: 'retained_metadata', hash: HASH_A, sizeBytes: 3 }, { kind: 'retained_metadata', hash: HASH_B }],
        });
        await writeFile(join(root, 'workspaces', 'ws1', `sha256_${'a'.repeat(64)}`), 'abc');
        const result = await observe();
        expect(result.canonical.retainedDeletedMetadataBytes).toBeNull();
        expect(result.filesystem.categories.unclassifiedFiles).toMatchObject({ files: 1, apparentBytes: 3 });
        expect(result.warnings).toContain('canonical_retained_metadata_unknown_size');
        expect(result.warnings).toContain('canonical_metadata_overlap');
    });

    it.each(['repeated_cursor', 'malformed_page', 'unsafe_total', 'conflicting_alias', 'page_limit'])('keeps canonical uncertainty explicit for %s', async failure => {
        let page = 0;
        const query = vi.fn(async (_event, input) => {
            if (input.kind !== 'live_metadata') return { items: [], hasMore: false };
            page++;
            if (failure === 'malformed_page') return { items: [], hasMore: 'false' };
            if (failure === 'unsafe_total') return { items: [{ kind: 'metadata', hash: HASH_A, sizeBytes: Number.MAX_SAFE_INTEGER }, { kind: 'metadata', hash: HASH_B, sizeBytes: 1 }], hasMore: false };
            if (failure === 'conflicting_alias') return { items: [{ kind: 'metadata', hash: HASH_A, sizeBytes: 3 }, { kind: 'metadata', hash: 'a'.repeat(64), sizeBytes: 4 }], hasMore: false };
            return { items: [], hasMore: true, nextCursor: failure === 'page_limit' ? String(page) : 'repeat' };
        });
        getActiveSyncGatewayAdapterMock.mockReturnValue({ capabilities: { retainedStorageMetadata: 'v1' }, queryCanonicalStorage: query });
        const result = await observe();
        expect(result.canonical.activeMetadataBytes).toBeNull();
        expect(result.canonical.complete.activeMetadata).toBe(false);
        expect(result.warnings.some(warning => warning.startsWith('canonical_live_metadata_'))).toBe(true);
        expect(query.mock.calls.filter(([, input]) => input.kind === 'live_metadata').length).toBeLessThanOrEqual(100);
    });

    it('bounds filesystem traversal and reports partial values as observations', async () => {
        useCanonical({});
        await writeFile(join(root, 'workspaces', 'ws1', 'first'), 'one');
        await writeFile(join(root, 'workspaces', 'ws1', 'second'), 'two');
        const result = await observe({ limit: 1 });
        expect(result.filesystem.complete).toBe(false);
        expect(result.filesystem.categories.unclassifiedFiles?.files).toBe(1);
        expect(result.warnings).toContain('filesystem_entry_limit');
    });

    it('does not follow symlinks and deduplicates hard-linked allocated blocks', async () => {
        useCanonical({});
        const workspace = join(root, 'workspaces', 'ws1');
        const target = join(workspace, 'first');
        await writeFile(target, 'one');
        await link(target, join(workspace, 'second'));
        await symlink(join(root, 'outside'), join(workspace, 'third'));
        await writeFile(join(root, 'outside'), 'outside-bytes');
        const result = await observe();
        expect(result.filesystem.apparentFileBytes).toBe(6);
        expect(result.filesystem.allocatedFileBytes).toBe((await stat(target)).blocks * 512);
        expect(result.filesystem.complete).toBe(false);
        expect(result.warnings).toContain('filesystem_non_regular_entry');
        expect(await readFile(join(root, 'outside'), 'utf8')).toBe('outside-bytes');
    });

    it('refuses workspace directory escapes without scanning other files', async () => {
        useCanonical({});
        await rm(join(root, 'workspaces', 'ws1'), { recursive: true });
        await symlink(root, join(root, 'workspaces', 'ws1'));
        const result = await observe();
        expect(result.filesystem.complete).toBe(false);
        expect(result.filesystem.apparentFileBytes).toBeNull();
        expect(result.warnings).toContain('filesystem_workspace_unavailable');
    });
});

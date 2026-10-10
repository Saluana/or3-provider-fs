import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';
import { fsStorageAdminAdapter } from '../storage-fs';

const observeUsageMock = vi.hoisted(() => vi.fn());
vi.mock('../../../storage/fs-usage', () => ({ observeFsStorageUsage: observeUsageMock }));
// This suite tests provider action dispatch; authorization behavior is exercised
// by the production observer integration tests rather than loading host hooks.
vi.mock('~~/server/auth/can', () => ({ requireCan: vi.fn() }));
vi.mock('~~/server/auth/session', () => ({ resolveSessionContext: vi.fn() }));

const getActiveSyncGatewayAdapterMock = vi.hoisted(() => vi.fn());
vi.mock('~~/server/sync/gateway/registry', () => ({
    getActiveSyncGatewayAdapter: getActiveSyncGatewayAdapterMock,
}));

describe('fsStorageAdminAdapter GC containment', () => {
    beforeEach(() => {
        observeUsageMock.mockReset().mockResolvedValue({ physicalCleanupEnabled: false });
        getActiveSyncGatewayAdapterMock.mockReset().mockReturnValue({ pull: vi.fn() });
        process.env.OR3_STORAGE_FS_ROOT = '/tmp/or3-storage';
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = 'x'.repeat(32);
        (globalThis as typeof globalThis & { useRuntimeConfig?: unknown }).useRuntimeConfig = () => ({
            auth: { enabled: true, strict: false },
            storage: { enabled: true, provider: 'fs' },
            public: { auth: { enabled: true }, storage: { enabled: true, provider: 'fs' } },
        });
    });

    afterEach(() => {
        delete process.env.OR3_STORAGE_FS_ROOT;
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
    });

    it('reports destructive GC disabled in provider status and action metadata', async () => {
        const result = await fsStorageAdminAdapter.getStatus(
            {} as H3Event,
            { enabled: true, provider: 'fs' },
        );

        expect(result.details).toMatchObject({
            gcStatus: 'disabled',
            gcDisabledReason: 'deletion_coordination_required',
        });
        expect(result.warnings).toContainEqual({
            level: 'warning',
            message:
                'Physical filesystem cleanup is disabled until uploads, canonical writes, and deletion share a durable coordination protocol. Deleted bytes remain on disk.',
        });
        expect(result.actions).toContainEqual({
            id: 'storage.gc',
            label: 'Check Storage GC Status',
            description:
                'Reports that destructive GC is disabled; does not scan sync history or delete files.',
        });
    });

    it('does not advertise destructive GC merely because canonical queries are available', async () => {
        getActiveSyncGatewayAdapterMock.mockReturnValue({ queryCanonicalStorage: vi.fn() });
        const result = await fsStorageAdminAdapter.getStatus(
            {} as H3Event,
            { enabled: true, provider: 'fs' },
        );

        expect(result.details).toMatchObject({ gcStatus: 'disabled', gcDisabledReason: 'deletion_coordination_required' });
        expect(result.actions).toContainEqual({
            id: 'storage.gc',
            label: 'Check Storage GC Status',
            description: 'Reports that destructive GC is disabled; does not scan sync history or delete files.',
        });
    });
    it('advertises a bounded read-only usage action', async () => {
        const result = await fsStorageAdminAdapter.getStatus({} as H3Event, { enabled: true, provider: 'fs' });
        expect(result.details).toMatchObject({ usageObservation: 'on_demand' });
        expect(result.actions).toContainEqual(expect.objectContaining({ id: 'storage.usage' }));
    });

    it('observes only the resolved workspace with explicit limits', async () => {
        const event = {} as H3Event;
        const context = { session: { workspace: { id: 'owner' } } } as Parameters<NonNullable<typeof fsStorageAdminAdapter.runAction>>[3];
        await fsStorageAdminAdapter.runAction!(event, 'storage.usage', { maxEntries: 2, maxMetadataRecords: 3 }, context);
        expect(observeUsageMock).toHaveBeenCalledWith(event, 'owner', { maxEntries: 2, maxMetadataRecords: 3 });
    });

    it.each(['10', null, {}])('rejects invalid observation limits instead of widening the scan (%s)', async maxEntries => {
        const context = { session: { workspace: { id: 'owner' } } } as Parameters<NonNullable<typeof fsStorageAdminAdapter.runAction>>[3];
        await expect(fsStorageAdminAdapter.runAction!({} as H3Event, 'storage.usage', { maxEntries }, context)).rejects.toMatchObject({ statusCode: 400 });
        expect(observeUsageMock).not.toHaveBeenCalled();
    });
});

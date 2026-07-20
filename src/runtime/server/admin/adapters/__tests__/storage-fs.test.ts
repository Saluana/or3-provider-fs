import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';
import { fsStorageAdminAdapter } from '../storage-fs';

const getActiveSyncGatewayAdapterMock = vi.hoisted(() => vi.fn());
vi.mock('~~/server/sync/gateway/registry', () => ({
    getActiveSyncGatewayAdapter: getActiveSyncGatewayAdapterMock,
}));

describe('fsStorageAdminAdapter GC containment', () => {
    beforeEach(() => {
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
            gcDisabledReason: 'canonical_reference_state_required',
        });
        expect(result.warnings).toContainEqual({
            level: 'warning',
            message:
                'Destructive filesystem blob GC is disabled until canonical reference state is available.',
        });
        expect(result.actions).toContainEqual({
            id: 'storage.gc',
            label: 'Check Storage GC Status',
            description:
                'Reports that destructive GC is disabled; does not scan sync history or delete files.',
        });
    });

    it('reports GC available only when the sync provider exposes canonical queries', async () => {
        getActiveSyncGatewayAdapterMock.mockReturnValue({ queryCanonicalStorage: vi.fn() });
        const result = await fsStorageAdminAdapter.getStatus(
            {} as H3Event,
            { enabled: true, provider: 'fs' },
        );

        expect(result.details).toMatchObject({ gcStatus: 'available' });
        expect(result.details).not.toHaveProperty('gcDisabledReason');
        expect(result.actions).toContainEqual({
            id: 'storage.gc',
            label: 'Run Storage GC',
            description: 'Deletes retained blobs only after canonical metadata and reference checks.',
        });
    });
});

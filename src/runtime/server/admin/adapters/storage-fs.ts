import { useRuntimeConfig } from '#imports';
import type { H3Event } from 'h3';
import { createError } from 'h3';
import type {
    ProviderAdminAdapter,
    ProviderActionContext,
    ProviderAdminStatusResult,
    ProviderStatusContext,
} from '~~/server/admin/providers/types';
import { createFsStorageGatewayAdapter } from '../../storage/fs-storage-gateway-adapter';
import { validateFsStorageConfig } from '../../storage/fs-config';
import { observeFsStorageUsage } from '../../storage/fs-usage';

const FS_PROVIDER_ID = 'fs';
const DEFAULT_RETENTION_SECONDS = 30 * 24 * 3600;

function resolveRetentionSeconds(payload?: Record<string, unknown>): number {
    const days = typeof payload?.retentionDays === 'number' ? payload.retentionDays : null;
    const seconds =
        typeof payload?.retentionSeconds === 'number' ? payload.retentionSeconds : null;
    if (seconds && Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds);
    if (days && Number.isFinite(days) && days > 0) return Math.floor(days * 24 * 3600);
    return DEFAULT_RETENTION_SECONDS;
}

function resolveLimit(payload?: Record<string, unknown>): number | undefined {
    const raw = payload?.limit;
    if (typeof raw !== 'number') return undefined;
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return Math.floor(raw);
}

export const fsStorageAdminAdapter: ProviderAdminAdapter = {
    id: FS_PROVIDER_ID,
    kind: 'storage',

    async getStatus(_event: H3Event, _ctx: ProviderStatusContext): Promise<ProviderAdminStatusResult> {
        const diagnostics = validateFsStorageConfig(useRuntimeConfig());
        const warnings: ProviderAdminStatusResult['warnings'] = [];

        for (const message of diagnostics.warnings) {
            warnings.push({ level: 'warning', message });
        }
        for (const message of diagnostics.errors) {
            warnings.push({ level: 'error', message });
        }
        warnings.push({
            level: 'warning',
            message:
                'Physical filesystem cleanup is disabled until uploads, canonical writes, and deletion share a durable coordination protocol. Deleted bytes remain on disk.',
        });

        return {
            details: {
                root: diagnostics.config.root,
                tokenSecretConfigured: Boolean(diagnostics.config.tokenSecret),
                urlTtlSeconds: diagnostics.config.urlTtlSeconds,
                gcStatus: 'disabled',
                gcDisabledReason: 'deletion_coordination_required',
                usageObservation: 'on_demand',
            },
            warnings,
            actions: [
                {
                    id: 'storage.gc',
                    label: 'Check Storage GC Status',
                    description: 'Reports that destructive GC is disabled; does not scan sync history or delete files.',
                },
                {
                    id: 'storage.usage',
                    label: 'Observe Storage Usage',
                    description: 'Read-only, bounded observation of logical metadata, retained bytes, incomplete transfers and disk allocation. Does not reclaim bytes.',
                },
            ],
        };
    },

    async runAction(
        event: H3Event,
        actionId: string,
        payload: Record<string, unknown> | undefined,
        ctx: ProviderActionContext
    ): Promise<unknown> {
        if (actionId !== 'storage.gc' && actionId !== 'storage.usage') {
            throw createError({ statusCode: 400, statusMessage: 'Unknown action' });
        }

        if (!ctx.session.workspace?.id) {
            throw createError({
                statusCode: 400,
                statusMessage: 'Workspace not resolved',
            });
        }

        if (actionId === 'storage.usage') {
            for (const key of ['maxEntries', 'maxMetadataRecords']) {
                if (payload?.[key] !== undefined && typeof payload[key] !== 'number') {
                    throw createError({ statusCode: 400, statusMessage: 'Invalid observation limit' });
                }
            }
            return observeFsStorageUsage(event, ctx.session.workspace.id, {
                maxEntries: typeof payload?.maxEntries === 'number' ? payload.maxEntries : undefined,
                maxMetadataRecords: typeof payload?.maxMetadataRecords === 'number' ? payload.maxMetadataRecords : undefined,
            });
        }

        const adapter = createFsStorageGatewayAdapter();
        const retentionSeconds = resolveRetentionSeconds(payload);
        const limit = resolveLimit(payload);

        return await adapter.gc?.(event, {
            workspace_id: ctx.session.workspace.id,
            retention_seconds: retentionSeconds,
            limit,
        });
    },
};

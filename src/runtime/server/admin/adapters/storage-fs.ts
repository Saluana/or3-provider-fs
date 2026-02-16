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

        return {
            details: {
                root: diagnostics.config.root,
                tokenSecretConfigured: Boolean(diagnostics.config.tokenSecret),
                urlTtlSeconds: diagnostics.config.urlTtlSeconds,
            },
            warnings,
            actions: [
                {
                    id: 'storage.gc',
                    label: 'Run Storage GC',
                    description:
                        'Delete orphaned filesystem blobs and stale metadata after the retention window.',
                    danger: true,
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
        if (actionId !== 'storage.gc') {
            throw createError({ statusCode: 400, statusMessage: 'Unknown action' });
        }

        if (!ctx.session.workspace?.id) {
            throw createError({
                statusCode: 400,
                statusMessage: 'Workspace not resolved',
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

/**
 * Nitro server plugin — registers the FS storage adapter.
 */
import { registerStorageGatewayAdapter } from '~~/server/storage/gateway/registry';
import { registerProviderAdminAdapter } from '~~/server/admin/providers/registry';
import { validateFsStorageConfig } from '../storage/fs-config';
import { createFsStorageGatewayAdapter } from '../storage/fs-storage-gateway-adapter';
import { fsStorageAdminAdapter } from '../admin/adapters/storage-fs';

export default defineNitroPlugin(() => {
    const config = useRuntimeConfig();
    const diagnostics = validateFsStorageConfig(config);
    for (const warning of diagnostics.warnings) {
        console.warn(`[or3-provider-fs] ${warning}`);
    }

    if (!diagnostics.config.authEnabled || !diagnostics.config.storageEnabled) return;
    if (diagnostics.config.providerId !== 'fs') return;

    if (!diagnostics.isValid) {
        const message = `${diagnostics.errors.join(' ')} Install/configure fs storage provider env values and restart.`;
        throw new Error(message);
    }

    registerStorageGatewayAdapter({
        id: 'fs',
        order: 100,
        create: createFsStorageGatewayAdapter,
    });

    registerProviderAdminAdapter(fsStorageAdminAdapter);
});

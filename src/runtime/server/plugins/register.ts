/**
 * Nitro server plugin — registers the FS storage adapter.
 */
import { registerStorageGatewayAdapter } from '~~/server/storage/gateway/registry';
import { createFsStorageGatewayAdapter } from '../storage/fs-storage-gateway-adapter';

export default defineNitroPlugin(() => {
    const config = useRuntimeConfig();
    const authEnabled = config.auth?.enabled ?? config.public?.auth?.enabled;
    if (!authEnabled) return;

    registerStorageGatewayAdapter({
        id: 'fs',
        order: 100,
        create: createFsStorageGatewayAdapter,
    });
});

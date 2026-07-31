import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerStorageGatewayAdapterMock = vi.hoisted(() => vi.fn());

vi.mock('nitropack/runtime/plugin', () => ({
    defineNitroPlugin: (plugin: () => unknown) => plugin(),
}));

vi.mock('~~/server/storage/gateway/registry', () => ({
    registerStorageGatewayAdapter: registerStorageGatewayAdapterMock as unknown,
}));

describe('fs register plugin', () => {
    beforeEach(() => {
        vi.resetModules();
        registerStorageGatewayAdapterMock.mockReset();

        process.env.OR3_STORAGE_FS_ROOT = '/tmp/or3-storage';
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = 'x'.repeat(32);
        delete process.env.OR3_STORAGE_FS_URL_TTL_SECONDS;

        (globalThis as typeof globalThis & { useRuntimeConfig?: unknown }).useRuntimeConfig = () => ({
            auth: { enabled: true, strict: false },
            storage: { enabled: true, provider: 'fs' },
            public: { auth: { enabled: true }, storage: { enabled: true, provider: 'fs' } },
        });
    });

    it('registers adapter when config is valid', async () => {
        await import('../register');
        expect(registerStorageGatewayAdapterMock).toHaveBeenCalledWith({
            id: 'fs',
            order: 100,
            create: expect.any(Function),
        });
    });

    it('fails startup when storage root is missing', async () => {
        delete process.env.OR3_STORAGE_FS_ROOT;
        await expect(import('../register')).rejects.toThrow('Missing OR3_STORAGE_FS_ROOT.');
        expect(registerStorageGatewayAdapterMock).not.toHaveBeenCalled();
    });

    it('fails startup when token secret is missing', async () => {
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        await expect(import('../register')).rejects.toThrow('Missing OR3_STORAGE_FS_TOKEN_SECRET.');
        expect(registerStorageGatewayAdapterMock).not.toHaveBeenCalled();
    });

    it('fails startup on invalid URL TTL', async () => {
        process.env.OR3_STORAGE_FS_URL_TTL_SECONDS = '0';
        await expect(import('../register')).rejects.toThrow(
            'OR3_STORAGE_FS_URL_TTL_SECONDS must be between 1 and 3600.',
        );
        expect(registerStorageGatewayAdapterMock).not.toHaveBeenCalled();
    });

    it('skips registration when fs provider is not active', async () => {
        (globalThis as typeof globalThis & { useRuntimeConfig?: unknown }).useRuntimeConfig = () => ({
            auth: { enabled: true, strict: false },
            storage: { enabled: true, provider: 'convex' },
            public: { auth: { enabled: true }, storage: { enabled: true, provider: 'convex' } },
        });

        await import('../register');
        expect(registerStorageGatewayAdapterMock).not.toHaveBeenCalled();
    });
});

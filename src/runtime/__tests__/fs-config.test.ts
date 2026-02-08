import { describe, it, expect, afterEach } from 'vitest';
import { resolveFsUrlTtlSeconds, validateFsStorageConfig } from '../server/storage/fs-config';

function makeRuntimeConfig(overrides: Record<string, unknown> = {}): ReturnType<typeof useRuntimeConfig> {
    return {
        auth: { enabled: true, strict: false },
        storage: { enabled: true, provider: 'fs' },
        public: { auth: { enabled: true }, storage: { enabled: true, provider: 'fs' } },
        ...overrides,
    } as ReturnType<typeof useRuntimeConfig>;
}

describe('fs-config', () => {
    afterEach(() => {
        delete process.env.OR3_STORAGE_FS_URL_TTL_SECONDS;
        delete process.env.OR3_STORAGE_FS_ROOT;
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
    });

    it('falls back to default TTL when env value is invalid', () => {
        process.env.OR3_STORAGE_FS_URL_TTL_SECONDS = 'not-a-number';
        expect(resolveFsUrlTtlSeconds()).toBe(900);
    });

    it('falls back to default TTL when env value is out of range', () => {
        process.env.OR3_STORAGE_FS_URL_TTL_SECONDS = '0';
        expect(resolveFsUrlTtlSeconds()).toBe(900);
    });

    it('accepts valid TTL from env', () => {
        process.env.OR3_STORAGE_FS_URL_TTL_SECONDS = '120';
        expect(resolveFsUrlTtlSeconds()).toBe(120);
    });

    it('validates required env vars', () => {
        const diagnostics = validateFsStorageConfig(makeRuntimeConfig());
        expect(diagnostics.isValid).toBe(false);
        expect(diagnostics.errors).toContain('Missing OR3_STORAGE_FS_ROOT.');
        expect(diagnostics.errors).toContain('Missing OR3_STORAGE_FS_TOKEN_SECRET.');
    });

    it('accepts valid absolute root and token secret', () => {
        process.env.OR3_STORAGE_FS_ROOT = '/tmp/or3-storage';
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = 'x'.repeat(32);
        const diagnostics = validateFsStorageConfig(makeRuntimeConfig());
        expect(diagnostics.isValid).toBe(true);
    });
});

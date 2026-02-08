import { isAbsolute } from 'node:path';

export interface FsStorageConfig {
    authEnabled: boolean;
    storageEnabled: boolean;
    providerId: string | undefined;
    strict: boolean;
    root: string | undefined;
    tokenSecret: string | undefined;
    urlTtlSeconds: number;
}

export interface FsStorageConfigDiagnostics {
    isValid: boolean;
    errors: string[];
    warnings: string[];
    config: FsStorageConfig;
}

const DEFAULT_URL_TTL_SECONDS = 900;
const MAX_URL_TTL_SECONDS = 24 * 60 * 60;

function isStrictMode(runtimeConfig: ReturnType<typeof useRuntimeConfig>): boolean {
    if (process.env.OR3_STRICT_CONFIG === 'true') return true;
    if (process.env.NODE_ENV === 'production') return true;
    return runtimeConfig.auth?.strict === true;
}

export function resolveFsUrlTtlSeconds(): number {
    const raw = process.env.OR3_STORAGE_FS_URL_TTL_SECONDS;
    if (!raw) return DEFAULT_URL_TTL_SECONDS;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_URL_TTL_SECONDS;

    const rounded = Math.floor(parsed);
    if (rounded < 1 || rounded > MAX_URL_TTL_SECONDS) {
        return DEFAULT_URL_TTL_SECONDS;
    }

    return rounded;
}

export function validateFsStorageConfig(
    runtimeConfig: ReturnType<typeof useRuntimeConfig>
): FsStorageConfigDiagnostics {
    const authEnabled = runtimeConfig.auth?.enabled === true || runtimeConfig.public?.auth?.enabled === true;
    const storageEnabled =
        runtimeConfig.storage?.enabled === true || runtimeConfig.public?.storage?.enabled === true;
    const providerId = (runtimeConfig.storage?.provider || runtimeConfig.public?.storage?.provider) as
        | string
        | undefined;

    const config: FsStorageConfig = {
        authEnabled,
        storageEnabled,
        providerId,
        strict: isStrictMode(runtimeConfig),
        root: process.env.OR3_STORAGE_FS_ROOT,
        tokenSecret: process.env.OR3_STORAGE_FS_TOKEN_SECRET,
        urlTtlSeconds: resolveFsUrlTtlSeconds(),
    };

    const errors: string[] = [];
    const warnings: string[] = [];

    if (!authEnabled) {
        warnings.push('auth.enabled=false; fs storage adapter registration skipped.');
    }
    if (!storageEnabled) {
        warnings.push('storage.enabled=false; fs storage adapter registration skipped.');
    }
    if (providerId && providerId !== 'fs') {
        warnings.push(`storage.provider=${providerId}; fs storage adapter remains idle.`);
    }

    if (!config.root) {
        errors.push('Missing OR3_STORAGE_FS_ROOT.');
    } else if (!isAbsolute(config.root)) {
        errors.push('OR3_STORAGE_FS_ROOT must be an absolute path.');
    }

    if (!config.tokenSecret) {
        errors.push('Missing OR3_STORAGE_FS_TOKEN_SECRET.');
    } else if (config.tokenSecret.length < 32) {
        warnings.push('OR3_STORAGE_FS_TOKEN_SECRET should be at least 32 characters.');
    }

    if (String(process.env.OR3_STORAGE_FS_URL_TTL_SECONDS ?? '').trim()) {
        const rawTtl = Number(process.env.OR3_STORAGE_FS_URL_TTL_SECONDS);
        if (!Number.isFinite(rawTtl) || rawTtl < 1 || rawTtl > MAX_URL_TTL_SECONDS) {
            warnings.push(
                `OR3_STORAGE_FS_URL_TTL_SECONDS is invalid; using default ${DEFAULT_URL_TTL_SECONDS}s.`
            );
        }
    }

    return {
        isValid: errors.length === 0,
        errors,
        warnings,
        config,
    };
}

/**
 * Hash parsing and normalization helpers for filesystem storage.
 */
import { createHash } from 'node:crypto';

export type FsHashAlgorithm = 'sha256' | 'md5';

export interface ParsedFsHash {
    algorithm: FsHashAlgorithm;
    hex: string;
    canonical: string;
    storageKey: string;
}

const SHA256_HASH = /^sha256:([a-f0-9]{64})$/i;
const MD5_HASH = /^md5:([a-f0-9]{32})$/i;
const LEGACY_SHA256_HASH = /^([a-f0-9]{64})$/i;
const LEGACY_MD5_HASH = /^([a-f0-9]{32})$/i;
const SHA256_STORAGE_KEY = /^sha256_([a-f0-9]{64})$/i;
const MD5_STORAGE_KEY = /^md5_([a-f0-9]{32})$/i;

function toParsedHash(algorithm: FsHashAlgorithm, hex: string): ParsedFsHash {
    return {
        algorithm,
        hex,
        canonical: `${algorithm}:${hex}`,
        storageKey: `${algorithm}_${hex}`,
    };
}

export function parseFsHash(hash: string): ParsedFsHash | null {
    const trimmed = hash.trim().toLowerCase();
    if (!trimmed) return null;

    const shaMatch = trimmed.match(SHA256_HASH);
    if (shaMatch) {
        return toParsedHash('sha256', shaMatch[1]!);
    }

    const md5Match = trimmed.match(MD5_HASH);
    if (md5Match) {
        return toParsedHash('md5', md5Match[1]!);
    }

    const legacySha256Match = trimmed.match(LEGACY_SHA256_HASH);
    if (legacySha256Match) {
        return toParsedHash('sha256', legacySha256Match[1]!);
    }

    const legacyMd5Match = trimmed.match(LEGACY_MD5_HASH);
    if (legacyMd5Match) {
        return toParsedHash('md5', legacyMd5Match[1]!);
    }

    return null;
}

export function parseFsStorageKey(storageKey: string): ParsedFsHash | null {
    const trimmed = storageKey.trim().toLowerCase();
    if (!trimmed) return null;

    const shaMatch = trimmed.match(SHA256_STORAGE_KEY);
    if (shaMatch) {
        return toParsedHash('sha256', shaMatch[1]!);
    }

    const md5Match = trimmed.match(MD5_STORAGE_KEY);
    if (md5Match) {
        return toParsedHash('md5', md5Match[1]!);
    }

    return parseFsHash(trimmed);
}

export function requireFsHash(hash: string): ParsedFsHash {
    const parsed = parseFsHash(hash);
    if (!parsed) {
        throw new Error('Invalid hash');
    }
    return parsed;
}

export function createFsHashDigestVerifier(hash: string): {
    update: (chunk: Uint8Array) => void;
    finalize: () => boolean;
} {
    const parsed = requireFsHash(hash);
    const hasher = createHash(parsed.algorithm);

    return {
        update(chunk: Uint8Array) {
            hasher.update(chunk);
        },
        finalize() {
            return hasher.digest('hex') === parsed.hex;
        },
    };
}

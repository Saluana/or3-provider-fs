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
const LEGACY_MD5_HASH = /^([a-f0-9]{32})$/i;

export function parseFsHash(hash: string): ParsedFsHash | null {
    const trimmed = hash.trim().toLowerCase();
    if (!trimmed) return null;

    const shaMatch = trimmed.match(SHA256_HASH);
    if (shaMatch) {
        const hex = shaMatch[1]!;
        return {
            algorithm: 'sha256',
            hex,
            canonical: `sha256:${hex}`,
            storageKey: `sha256_${hex}`,
        };
    }

    const md5Match = trimmed.match(MD5_HASH);
    if (md5Match) {
        const hex = md5Match[1]!;
        return {
            algorithm: 'md5',
            hex,
            canonical: `md5:${hex}`,
            storageKey: `md5_${hex}`,
        };
    }

    const legacyMd5Match = trimmed.match(LEGACY_MD5_HASH);
    if (legacyMd5Match) {
        const hex = legacyMd5Match[1]!;
        return {
            algorithm: 'md5',
            hex,
            canonical: `md5:${hex}`,
            storageKey: `md5_${hex}`,
        };
    }

    return null;
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

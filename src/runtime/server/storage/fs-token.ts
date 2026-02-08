/**
 * @module fs-token
 *
 * Signed JWT tokens for short-lived upload/download authorization.
 * Tokens encode the operation type, workspace scope, content hash,
 * and optional size/mime constraints. Verified at endpoint level.
 */
import jwt from 'jsonwebtoken';
import { parseFsHash } from './fs-hash';

export interface FsStorageTokenPayload {
    op: 'upload' | 'download';
    workspace_id: string;
    user_id: string;
    hash: string;
    size_bytes?: number;
    mime_type?: string;
}

const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_-]+$/;

function getSecret(): string {
    const secret = process.env.OR3_STORAGE_FS_TOKEN_SECRET;
    if (!secret) throw new Error('Missing OR3_STORAGE_FS_TOKEN_SECRET');
    return secret;
}

function assertTokenPayload(
    payload: unknown
): asserts payload is FsStorageTokenPayload & { exp: number; iat: number } {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid token payload');
    }
    const candidate = payload as Record<string, unknown>;

    if (candidate.op !== 'upload' && candidate.op !== 'download') {
        throw new Error('Invalid token operation');
    }

    if (typeof candidate.workspace_id !== 'string' || !SAFE_WORKSPACE_ID.test(candidate.workspace_id)) {
        throw new Error('Invalid workspace ID');
    }

    if (typeof candidate.user_id !== 'string' || candidate.user_id.trim().length === 0) {
        throw new Error('Invalid user ID');
    }

    if (typeof candidate.hash !== 'string' || !parseFsHash(candidate.hash)) {
        throw new Error('Invalid hash');
    }

    const sizeBytes = candidate.size_bytes;
    if (
        sizeBytes !== undefined &&
        (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0 || !Number.isInteger(sizeBytes))
    ) {
        throw new Error('Invalid size_bytes claim');
    }

    if (
        candidate.mime_type !== undefined &&
        (typeof candidate.mime_type !== 'string' || candidate.mime_type.trim().length === 0)
    ) {
        throw new Error('Invalid mime_type claim');
    }

    if (typeof candidate.exp !== 'number' || typeof candidate.iat !== 'number') {
        throw new Error('Invalid token timestamps');
    }
}

/**
 * Sign a short-lived token for an fs storage operation.
 */
export function signFsToken(payload: FsStorageTokenPayload, ttlSeconds: number): string {
    return jwt.sign(payload, getSecret(), { algorithm: 'HS256', expiresIn: ttlSeconds });
}

/**
 * Verify and decode an fs storage token.
 * Throws on expired, tampered, or malformed tokens.
 */
export function verifyFsToken(token: string): FsStorageTokenPayload & { exp: number; iat: number } {
    const verified = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
    assertTokenPayload(verified);
    return verified;
}

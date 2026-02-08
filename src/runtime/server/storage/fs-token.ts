/**
 * @module fs-token
 *
 * Signed JWT tokens for short-lived upload/download authorization.
 * Tokens encode the operation type, workspace scope, content hash,
 * and optional size/mime constraints. Verified at endpoint level.
 */
import jwt from 'jsonwebtoken';

export interface FsStorageTokenPayload {
    op: 'upload' | 'download';
    workspace_id: string;
    hash: string;
    size_bytes?: number;
    mime_type?: string;
}

function getSecret(): string {
    const secret = process.env.OR3_STORAGE_FS_TOKEN_SECRET;
    if (!secret) throw new Error('Missing OR3_STORAGE_FS_TOKEN_SECRET');
    return secret;
}

/**
 * Sign a short-lived token for an fs storage operation.
 */
export function signFsToken(payload: FsStorageTokenPayload, ttlSeconds: number): string {
    return jwt.sign(payload, getSecret(), { expiresIn: ttlSeconds });
}

/**
 * Verify and decode an fs storage token.
 * Throws on expired, tampered, or malformed tokens.
 */
export function verifyFsToken(token: string): FsStorageTokenPayload & { exp: number; iat: number } {
    return jwt.verify(token, getSecret()) as FsStorageTokenPayload & { exp: number; iat: number };
}

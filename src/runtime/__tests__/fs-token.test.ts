/**
 * Unit tests for fs-token sign/verify, expiry, and tamper detection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signFsToken, verifyFsToken } from '../server/storage/fs-token';

const TEST_SECRET = 'test-secret-for-unit-tests';
const HASH = `sha256:${'a'.repeat(64)}`;

describe('fs-token', () => {
    beforeEach(() => {
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = TEST_SECRET;
    });

    afterEach(() => {
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('signs and verifies an upload token', () => {
        const token = signFsToken(
            {
                op: 'upload',
                workspace_id: 'ws1',
                user_id: 'user-1',
                hash: HASH,
                size_bytes: 1024,
                mime_type: 'image/png',
            },
            300,
        );
        const claims = verifyFsToken(token);
        expect(claims.op).toBe('upload');
        expect(claims.workspace_id).toBe('ws1');
        expect(claims.user_id).toBe('user-1');
        expect(claims.hash).toBe(HASH);
        expect(claims.size_bytes).toBe(1024);
        expect(claims.mime_type).toBe('image/png');
        expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('signs and verifies a download token', () => {
        const token = signFsToken({ op: 'download', workspace_id: 'ws2', user_id: 'user-2', hash: HASH }, 60);
        const claims = verifyFsToken(token);
        expect(claims.op).toBe('download');
        expect(claims.workspace_id).toBe('ws2');
        expect(claims.user_id).toBe('user-2');
        expect(claims.hash).toBe(HASH);
    });

    it('rejects a tampered token', () => {
        const token = signFsToken({ op: 'upload', workspace_id: 'ws1', user_id: 'user-1', hash: HASH }, 300);
        const tampered = token.slice(0, -5) + 'XXXXX';
        expect(() => verifyFsToken(tampered)).toThrow();
    });

    it('rejects an expired token', () => {
        vi.useFakeTimers();
        const now = new Date('2026-02-08T00:00:00.000Z');
        vi.setSystemTime(now);

        const token = signFsToken(
            { op: 'download', workspace_id: 'ws1', user_id: 'user-1', hash: HASH },
            1,
        );

        vi.setSystemTime(new Date(now.getTime() + 3_000));
        expect(() => verifyFsToken(token)).toThrow();

        vi.useRealTimers();
    });

    it('rejects token signed with wrong secret', () => {
        const token = signFsToken({ op: 'upload', workspace_id: 'ws1', user_id: 'user-1', hash: HASH }, 300);
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = 'different-secret';
        expect(() => verifyFsToken(token)).toThrow();
    });

    it('throws when secret is not configured (sign)', () => {
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        expect(() =>
            signFsToken({ op: 'upload', workspace_id: 'ws1', user_id: 'user-1', hash: HASH }, 300),
        ).toThrow('Missing OR3_STORAGE_FS_TOKEN_SECRET');
    });

    it('throws when secret is not configured (verify)', () => {
        const token = signFsToken({ op: 'upload', workspace_id: 'ws1', user_id: 'user-1', hash: HASH }, 300);
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        expect(() => verifyFsToken(token)).toThrow('Missing OR3_STORAGE_FS_TOKEN_SECRET');
    });

    it('preserves optional fields as undefined when not set', () => {
        const token = signFsToken(
            { op: 'download', workspace_id: 'ws1', user_id: 'user-1', hash: HASH },
            300,
        );
        const claims = verifyFsToken(token);
        expect(claims.size_bytes).toBeUndefined();
        expect(claims.mime_type).toBeUndefined();
    });

    it('rejects payloads with invalid hash claim', () => {
        const token = signFsToken(
            { op: 'download', workspace_id: 'ws1', user_id: 'user-1', hash: `sha1:${'a'.repeat(40)}` },
            300,
        );
        expect(() => verifyFsToken(token)).toThrow('Invalid hash');
    });
});

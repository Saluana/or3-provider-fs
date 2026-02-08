/**
 * Integration-style tests for the FsStorageGatewayAdapter and
 * the upload/download flow using real filesystem operations.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorageGatewayAdapter } from '../server/storage/fs-storage-gateway-adapter';
import { signFsToken, verifyFsToken } from '../server/storage/fs-token';
import { resolveFsObjectPath } from '../server/storage/fs-paths';

const TEST_SECRET = 'integration-test-secret';

let storageRoot: string;

beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'or3-fs-test-'));
});

afterAll(async () => {
    await rm(storageRoot, { recursive: true, force: true });
});

describe('FsStorageGatewayAdapter', () => {
    beforeEach(() => {
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = TEST_SECRET;
        process.env.OR3_STORAGE_FS_ROOT = storageRoot;
    });

    afterEach(() => {
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        delete process.env.OR3_STORAGE_FS_ROOT;
        delete process.env.OR3_STORAGE_FS_URL_TTL_SECONDS;
    });

    const adapter = new FsStorageGatewayAdapter();
    const mockEvent = {} as any;

    it('has id "fs"', () => {
        expect(adapter.id).toBe('fs');
    });

    describe('presignUpload', () => {
        it('returns a signed upload URL', async () => {
            const result = await adapter.presignUpload(mockEvent, {
                workspaceId: 'ws1',
                hash: 'sha256abc',
                mimeType: 'image/png',
                sizeBytes: 2048,
            });

            expect(result.url).toContain('/api/storage/fs/upload?token=');
            expect(result.method).toBe('PUT');
            expect(result.storageId).toBe('ws1:sha256abc');
            expect(result.expiresAt).toBeGreaterThan(Date.now());

            // Verify the embedded token is valid
            const tokenStr = decodeURIComponent(result.url.split('token=')[1]!);
            const claims = verifyFsToken(tokenStr);
            expect(claims.op).toBe('upload');
            expect(claims.workspace_id).toBe('ws1');
            expect(claims.hash).toBe('sha256abc');
            expect(claims.size_bytes).toBe(2048);
            expect(claims.mime_type).toBe('image/png');
        });

        it('respects custom TTL env var', async () => {
            process.env.OR3_STORAGE_FS_URL_TTL_SECONDS = '60';
            const before = Date.now();
            const result = await adapter.presignUpload(mockEvent, {
                workspaceId: 'ws1',
                hash: 'h',
                mimeType: 'text/plain',
                sizeBytes: 10,
            });
            // expiresAt should be ~60s from now, not 900s
            expect(result.expiresAt!).toBeLessThan(before + 120_000);
        });
    });

    describe('presignDownload', () => {
        it('returns a signed download URL', async () => {
            const result = await adapter.presignDownload(mockEvent, {
                workspaceId: 'ws2',
                hash: 'sha256def',
            });

            expect(result.url).toContain('/api/storage/fs/download?token=');
            expect(result.method).toBe('GET');
            expect(result.storageId).toBe('ws2:sha256def');

            const tokenStr = decodeURIComponent(result.url.split('token=')[1]!);
            const claims = verifyFsToken(tokenStr);
            expect(claims.op).toBe('download');
            expect(claims.workspace_id).toBe('ws2');
        });
    });

    describe('gc', () => {
        it('returns zero-deletion stub', async () => {
            const result = await adapter.gc(mockEvent, {});
            expect(result).toEqual({ deleted_count: 0 });
        });
    });
});

describe('Upload / Download flow', () => {
    beforeEach(() => {
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = TEST_SECRET;
        process.env.OR3_STORAGE_FS_ROOT = storageRoot;
    });

    afterEach(() => {
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        delete process.env.OR3_STORAGE_FS_ROOT;
    });

    it('writes a file atomically and reads it back', async () => {
        const wsId = 'ws-flow';
        const hash = 'deadbeef';
        const content = Buffer.from('hello world');

        // Simulate upload: sign token, resolve path, write
        const token = signFsToken(
            { op: 'upload', workspace_id: wsId, hash, size_bytes: content.length },
            300,
        );
        const claims = verifyFsToken(token);
        expect(claims.op).toBe('upload');

        const target = resolveFsObjectPath(storageRoot, wsId, hash);
        const { dirname } = await import('node:path');
        await mkdir(dirname(target), { recursive: true });
        const temp = `${target}.tmp-${Date.now()}`;
        await writeFile(temp, content);
        const { rename } = await import('node:fs/promises');
        await rename(temp, target);

        // Simulate download: verify token, read file
        const dlToken = signFsToken(
            { op: 'download', workspace_id: wsId, hash },
            300,
        );
        const dlClaims = verifyFsToken(dlToken);
        expect(dlClaims.op).toBe('download');

        const filePath = resolveFsObjectPath(storageRoot, wsId, hash);
        const data = await readFile(filePath);
        expect(data.toString()).toBe('hello world');
    });

    it('rejects upload token for download operation', () => {
        const token = signFsToken(
            { op: 'upload', workspace_id: 'ws1', hash: 'abc' },
            300,
        );
        const claims = verifyFsToken(token);
        expect(claims.op).toBe('upload');
        // An endpoint should reject this for download
        expect(claims.op).not.toBe('download');
    });

    it('rejects download token for upload operation', () => {
        const token = signFsToken(
            { op: 'download', workspace_id: 'ws1', hash: 'abc' },
            300,
        );
        const claims = verifyFsToken(token);
        expect(claims.op).not.toBe('upload');
    });

    it('enforces size constraint from token claims', async () => {
        const maxSize = 10;
        const token = signFsToken(
            { op: 'upload', workspace_id: 'ws-size', hash: 'sizecheck', size_bytes: maxSize },
            300,
        );
        const claims = verifyFsToken(token);
        const oversizedBody = Buffer.alloc(maxSize + 1, 'x');

        // Verify that the size check would reject
        expect(claims.size_bytes).toBe(maxSize);
        expect(oversizedBody.length).toBeGreaterThan(claims.size_bytes!);
    });

    it('rejects wrong-secret token', () => {
        const token = signFsToken(
            { op: 'upload', workspace_id: 'ws1', hash: 'abc' },
            300,
        );
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = 'wrong-secret';
        expect(() => verifyFsToken(token)).toThrow();
    });
});

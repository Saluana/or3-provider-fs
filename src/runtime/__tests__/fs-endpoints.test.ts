import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp, toWebHandler, type H3Event } from 'h3';
import downloadHandler from '../server/api/storage/fs/download.get';
import uploadHandler from '../server/api/storage/fs/upload.put';
import { resolveFsObjectPath } from '../server/storage/fs-paths';
import { signFsToken } from '../server/storage/fs-token';
import { FsStorageGatewayAdapter } from '../server/storage/fs-storage-gateway-adapter';

const requireCanMock = vi.hoisted(() => vi.fn());
const resolveSessionContextMock = vi.hoisted(() => vi.fn());
const getActiveSyncGatewayAdapterMock = vi.hoisted(() => vi.fn());

vi.mock('~~/server/auth/can', () => ({
    requireCan: requireCanMock as unknown,
}));

vi.mock('~~/server/auth/session', () => ({
    resolveSessionContext: resolveSessionContextMock as unknown,
}));

vi.mock('~~/server/sync/gateway/registry', () => ({
    getActiveSyncGatewayAdapter: getActiveSyncGatewayAdapterMock as unknown,
}));

const TEST_SECRET = 'endpoint-test-secret';

let storageRoot: string;

function makeSha256Hash(input: Buffer): string {
    return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

async function readNodeStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function createMockEvent(input: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Buffer;
}): H3Event {
    const requestUrl = `http://localhost${input.path}`;
    const requestHeaders = new Headers(input.headers ?? {});
    const reqWeb = new Request(requestUrl, {
        method: input.method,
        headers: requestHeaders,
        body: input.body,
        duplex: 'half',
    } as RequestInit);

    const req = Readable.from(input.body ? [input.body] : []) as Readable & {
        method?: string;
        url?: string;
        headers?: Record<string, string>;
        connection?: { encrypted?: boolean };
    };
    req.method = input.method;
    req.url = input.path;
    req.headers = Object.fromEntries(
        Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    req.connection = { encrypted: false };

    const responseHeaders = new Map<string, string | string[]>();
    const res = {
        setHeader(name: string, value: string | string[]) {
            responseHeaders.set(name.toLowerCase(), value);
        },
        getHeader(name: string) {
            return responseHeaders.get(name.toLowerCase());
        },
        removeHeader(name: string) {
            responseHeaders.delete(name.toLowerCase());
        },
        getHeaders() {
            return Object.fromEntries(responseHeaders.entries());
        },
    };

    const resWeb = {
        status: 200,
        statusText: '',
        headers: new Headers(),
    };

    return {
        path: input.path,
        context: {},
        req: reqWeb,
        res: resWeb,
        node: {
            req,
            res,
        },
    } as unknown as H3Event;
}

describe('fs upload/download handlers', () => {
    beforeEach(async () => {
        storageRoot = await mkdtemp(join(tmpdir(), 'or3-fs-endpoint-'));
        process.env.OR3_STORAGE_FS_ROOT = storageRoot;
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = TEST_SECRET;

        resolveSessionContextMock.mockResolvedValue({
            authenticated: true,
            user: { id: 'user-1' },
            workspace: { id: 'ws1', name: 'Workspace' },
            role: 'owner',
        });
        requireCanMock.mockReset();
        getActiveSyncGatewayAdapterMock.mockReset().mockReturnValue({
            pull: vi.fn().mockResolvedValue({
                changes: [],
                nextCursor: 0,
                hasMore: false,
            }),
        });
    });

    afterEach(async () => {
        delete process.env.OR3_STORAGE_FS_ROOT;
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        requireCanMock.mockReset();
        resolveSessionContextMock.mockReset();
        getActiveSyncGatewayAdapterMock.mockReset();
        await rm(storageRoot, { recursive: true, force: true });
    });

    it('rejects upload when digest does not match token hash', async () => {
        const payload = Buffer.from('tampered-content');
        const hash = makeSha256Hash(Buffer.from('different-content'));
        const token = signFsToken(
            {
                op: 'upload',
                workspace_id: 'ws1',
                user_id: 'user-1',
                hash,
                size_bytes: payload.length,
                mime_type: 'text/plain',
            },
            300,
        );

        const event = createMockEvent({
            method: 'PUT',
            path: `/api/storage/fs/upload?token=${encodeURIComponent(token)}`,
            headers: {
                'content-type': 'text/plain',
            },
            body: payload,
        });

        await expect(uploadHandler(event)).rejects.toMatchObject({
            statusCode: 400,
            statusMessage: 'Hash mismatch',
        });
    });

    it('accepts bare sha256 hash tokens and resolves object path safely', async () => {
        const payload = Buffer.from('hello bare hash');
        const bareHash = createHash('sha256').update(payload).digest('hex');
        const token = signFsToken(
            {
                op: 'upload',
                workspace_id: 'ws1',
                user_id: 'user-1',
                hash: bareHash,
                size_bytes: payload.length,
                mime_type: 'text/plain',
            },
            300,
        );

        const event = createMockEvent({
            method: 'PUT',
            path: `/api/storage/fs/upload?token=${encodeURIComponent(token)}`,
            headers: { 'content-type': 'text/plain' },
            body: payload,
        });

        await expect(uploadHandler(event)).resolves.toEqual({
            ok: true,
            storage_id: `ws1:${bareHash}`,
        });

        const objectPath = resolveFsObjectPath(storageRoot, 'ws1', bareHash);
        await expect(readFile(objectPath)).resolves.toEqual(payload);
    });

    it('rejects upload for token subject mismatch', async () => {
        const payload = Buffer.from('subject mismatch');
        const hash = makeSha256Hash(payload);
        const token = signFsToken(
            {
                op: 'upload',
                workspace_id: 'ws1',
                user_id: 'different-user',
                hash,
                size_bytes: payload.length,
                mime_type: 'text/plain',
            },
            300,
        );

        const event = createMockEvent({
            method: 'PUT',
            path: `/api/storage/fs/upload?token=${encodeURIComponent(token)}`,
            headers: {
                'content-type': 'text/plain',
            },
            body: payload,
        });

        await expect(uploadHandler(event)).rejects.toMatchObject({
            statusCode: 403,
            statusMessage: 'Invalid token subject',
        });
    });

    it('accepts a zero-byte upload when the hash matches the empty body', async () => {
        const payload = Buffer.alloc(0);
        const hash = makeSha256Hash(payload);
        const token = signFsToken(
            {
                op: 'upload',
                workspace_id: 'ws1',
                user_id: 'user-1',
                hash,
                size_bytes: 0,
                mime_type: 'application/octet-stream',
            },
            300,
        );

        await expect(uploadHandler(createMockEvent({
            method: 'PUT',
            path: `/api/storage/fs/upload?token=${encodeURIComponent(token)}`,
            headers: { 'content-type': 'application/octet-stream' },
            body: payload,
        }))).resolves.toEqual({
            ok: true,
            storage_id: `ws1:${hash}`,
        });
        await expect(readFile(resolveFsObjectPath(storageRoot, 'ws1', hash))).resolves.toEqual(payload);
    });

    it('streams download with content-type header', async () => {
        const payload = Buffer.from('download me');
        const hash = makeSha256Hash(payload);
        const objectPath = resolveFsObjectPath(storageRoot, 'ws1', hash);
        await mkdir(dirname(objectPath), { recursive: true });
        await writeFile(objectPath, payload);

        const token = signFsToken(
            {
                op: 'download',
                workspace_id: 'ws1',
                user_id: 'user-1',
                hash,
                mime_type: 'text/plain',
            },
            300,
        );

        const event = createMockEvent({
            method: 'GET',
            path: `/api/storage/fs/download?token=${encodeURIComponent(token)}`,
        });

        await downloadHandler(event);
        const stream = (event as unknown as { node: { res: { _data: NodeJS.ReadableStream } } }).node.res._data;
        await expect(readNodeStream(stream)).resolves.toEqual(payload);
        const responseHeaders = (event as unknown as { node: { res: { getHeader(name: string): string | string[] | undefined } } }).node.res;
        expect(responseHeaders.getHeader('content-type')).toBe('application/octet-stream');
        expect(responseHeaders.getHeader('content-disposition')).toBe("attachment; filename*=UTF-8''download");
        expect(responseHeaders.getHeader('x-content-type-options')).toBe('nosniff');
    });

    it('serves authenticated byte ranges and restarts when the validator changes', async () => {
        const payload = Buffer.from('0123456789');
        const hash = makeSha256Hash(payload);
        const objectPath = resolveFsObjectPath(storageRoot, 'ws1', hash);
        await mkdir(dirname(objectPath), { recursive: true });
        await writeFile(objectPath, payload);
        const token = signFsToken({ op: 'download', workspace_id: 'ws1', user_id: 'user-1', hash }, 300);
        const request = (headers: Record<string, string> = {}) => createMockEvent({
            method: 'GET', path: `/api/storage/fs/download?token=${encodeURIComponent(token)}`, headers,
        });
        const full = request();
        await downloadHandler(full);
        const fullRes = full.node.res as unknown as { _data: NodeJS.ReadableStream; getHeader(name: string): string; statusCode: number };
        expect(await readNodeStream(fullRes._data)).toEqual(payload);
        expect(fullRes.getHeader('content-length')).toBe(10);
        const etag = fullRes.getHeader('etag');
        expect(etag).toMatch(/^"[^" ]+"$/);
        const partial = request({ range: 'bytes=3-6', 'if-range': etag });
        await downloadHandler(partial);
        const partialRes = partial.node.res as unknown as typeof fullRes;
        expect(partialRes.statusCode).toBe(206);
        expect(partialRes.getHeader('content-range')).toBe('bytes 3-6/10');
        expect(partialRes.getHeader('content-length')).toBe(4);
        expect(partialRes.getHeader('cache-control')).toBe('private, no-store');
        expect(await readNodeStream(partialRes._data)).toEqual(Buffer.from('3456'));
        const suffix = request({ range: 'bytes=-3' });
        await downloadHandler(suffix);
        const suffixRes = suffix.node.res as unknown as typeof fullRes;
        expect(suffixRes.statusCode).toBe(206);
        expect(suffixRes.getHeader('content-range')).toBe('bytes 7-9/10');
        expect(await readNodeStream(suffixRes._data)).toEqual(Buffer.from('789'));
        const restart = request({ range: 'bytes=3-', 'if-range': '"different"' });
        await downloadHandler(restart);
        const restartRes = restart.node.res as unknown as typeof fullRes;
        expect(await readNodeStream(restartRes._data)).toEqual(payload);
        const invalid = request({ range: 'bytes=99-' });
        await expect(downloadHandler(invalid)).rejects.toMatchObject({ statusCode: 416 });
        expect((invalid.node.res as unknown as typeof fullRes).getHeader('content-range')).toBe('bytes */10');
        requireCanMock.mockImplementationOnce(() => { throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); });
        await expect(downloadHandler(request({ range: 'bytes=3-', 'if-range': etag }))).rejects.toMatchObject({ statusCode: 403 });
        await writeFile(objectPath, Buffer.from('abcdefghij'));
        const changed = request({ range: 'bytes=3-', 'if-range': etag });
        await downloadHandler(changed);
        const changedRes = changed.node.res as unknown as typeof fullRes;
        expect(changedRes.getHeader('etag')).not.toBe(etag);
        expect(await readNodeStream(changedRes._data)).toEqual(Buffer.from('abcdefghij'));
    });

    it('delivers 206 and 416 responses through the HTTP adapter', async () => {
        const payload = Buffer.from('0123456789');
        const hash = makeSha256Hash(payload);
        const objectPath = resolveFsObjectPath(storageRoot, 'ws1', hash);
        await mkdir(dirname(objectPath), { recursive: true });
        await writeFile(objectPath, payload);
        const token = signFsToken({ op: 'download', workspace_id: 'ws1', user_id: 'user-1', hash }, 300);
        const app = createApp();
        app.use(downloadHandler);
        const request = toWebHandler(app);
        const url = `http://localhost/api/storage/fs/download?token=${encodeURIComponent(token)}`;
        const partial = await request(new Request(url, { headers: { range: 'bytes=2-4' } }));
        expect(partial.status).toBe(206);
        expect(partial.headers.get('content-range')).toBe('bytes 2-4/10');
        expect(await partial.text()).toBe('234');
        const invalid = await request(new Request(url, { headers: { range: 'bytes=99-' } }));
        expect(invalid.status).toBe(416);
        expect(invalid.headers.get('content-range')).toBe('bytes */10');
        expect(invalid.headers.get('content-length')).not.toBe('10');
    });

    it('rejects download for token subject mismatch', async () => {
        const payload = Buffer.from('download mismatch');
        const hash = makeSha256Hash(payload);
        const objectPath = resolveFsObjectPath(storageRoot, 'ws1', hash);
        await mkdir(dirname(objectPath), { recursive: true });
        await writeFile(objectPath, payload);

        const token = signFsToken(
            {
                op: 'download',
                workspace_id: 'ws1',
                user_id: 'different-user',
                hash,
                mime_type: 'text/plain',
            },
            300,
        );

        const event = createMockEvent({
            method: 'GET',
            path: `/api/storage/fs/download?token=${encodeURIComponent(token)}`,
        });

        await expect(downloadHandler(event)).rejects.toMatchObject({
            statusCode: 403,
            statusMessage: 'Invalid token subject',
        });
    });

    it('rejects a signed download when the object is an escaping symlink', async () => {
        const payload = Buffer.from('outside-secret');
        const hash = makeSha256Hash(payload);
        const objectPath = resolveFsObjectPath(storageRoot, 'ws1', hash);
        const outsideRoot = await mkdtemp(join(tmpdir(), 'or3-fs-endpoint-outside-'));
        const outsidePath = join(outsideRoot, 'secret.txt');
        await mkdir(dirname(objectPath), { recursive: true });
        await writeFile(outsidePath, payload);
        await symlink(outsidePath, objectPath);

        const token = signFsToken(
            {
                op: 'download',
                workspace_id: 'ws1',
                user_id: 'user-1',
                hash,
                mime_type: 'text/plain',
            },
            300,
        );
        const event = createMockEvent({
            method: 'GET',
            path: `/api/storage/fs/download?token=${encodeURIComponent(token)}`,
        });

        try {
            await expect(downloadHandler(event)).rejects.toMatchObject({
                statusCode: 404,
                statusMessage: 'File not found',
            });
        } finally {
            await rm(outsideRoot, { recursive: true, force: true });
        }
    });

    it('runs upload -> integrity -> download and reports destructive GC disabled', async () => {
        const payload = Buffer.from('roundtrip + gc');
        const hash = makeSha256Hash(payload);
        const workspaceId = 'ws1';
        const adapter = new FsStorageGatewayAdapter();
        const staleTime = new Date(Date.now() - 2 * 24 * 3600 * 1000);

        const uploadToken = signFsToken(
            {
                op: 'upload',
                workspace_id: workspaceId,
                user_id: 'user-1',
                hash,
                size_bytes: payload.length,
                mime_type: 'text/plain',
            },
            300,
        );
        await expect(
            uploadHandler(
                createMockEvent({
                    method: 'PUT',
                    path: `/api/storage/fs/upload?token=${encodeURIComponent(uploadToken)}`,
                    headers: { 'content-type': 'text/plain' },
                    body: payload,
                }),
            ),
        ).resolves.toEqual({ ok: true, storage_id: `${workspaceId}:${hash}` });

        await expect(adapter.readChatAttachment({} as H3Event, { workspaceId, hash, storageId: `${workspaceId}:${hash}` }))
            .rejects.toMatchObject({ statusCode: 404 });
        await adapter.commit({} as H3Event, {
            workspace_id: workspaceId,
            hash,
        });

        const chatOriginal = await adapter.readChatAttachment({} as H3Event, { workspaceId, hash, storageId: `${workspaceId}:${hash}` });
        expect(Buffer.from(await chatOriginal.arrayBuffer())).toEqual(payload);
        await expect(adapter.readChatAttachment({} as H3Event, { workspaceId, hash, storageId: `other:${hash}` }))
            .rejects.toMatchObject({ statusCode: 404 });

        const downloadToken = signFsToken(
            {
                op: 'download',
                workspace_id: workspaceId,
                user_id: 'user-1',
                hash,
                mime_type: 'text/plain',
            },
            300,
        );
        const downloadEvent = createMockEvent({
            method: 'GET',
            path: `/api/storage/fs/download?token=${encodeURIComponent(downloadToken)}`,
        });
        await downloadHandler(downloadEvent);
        const stream = (downloadEvent as unknown as { node: { res: { _data: NodeJS.ReadableStream } } }).node.res._data;
        await expect(readNodeStream(stream)).resolves.toEqual(payload);

        const objectPath = resolveFsObjectPath(storageRoot, workspaceId, hash);
        const metadataPath = `${objectPath}.meta.json`;
        const { utimesSync } = await import('node:fs');
        utimesSync(objectPath, staleTime, staleTime);
        utimesSync(metadataPath, staleTime, staleTime);

        getActiveSyncGatewayAdapterMock.mockClear().mockReturnValueOnce({
            pull: vi.fn().mockResolvedValue({
                changes: [
                    {
                        tableName: 'file_meta',
                        pk: hash,
                        op: 'delete',
                        payload: undefined,
                    },
                ],
                nextCursor: 1,
                hasMore: false,
            }),
        });

        await expect(
            adapter.gc({} as H3Event, {
                workspace_id: workspaceId,
                retention_seconds: 3600,
            }),
        ).resolves.toEqual({
            deleted_count: 0,
            status: 'disabled',
            reason: 'deletion_coordination_required',
        });
        await expect(readFile(objectPath)).resolves.toEqual(payload);
        await expect(readFile(metadataPath)).resolves.toBeTruthy();
        expect(getActiveSyncGatewayAdapterMock).not.toHaveBeenCalled();
    });
});

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { H3Event } from 'h3';
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

    it('streams upload to disk and verifies hash', async () => {
        const payload = Buffer.from('hello from upload endpoint');
        const hash = makeSha256Hash(payload);
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

        await expect(uploadHandler(event)).resolves.toEqual({
            ok: true,
            storage_id: `ws1:${hash}`,
        });

        const path = resolveFsObjectPath(storageRoot, 'ws1', hash);
        await expect(readFile(path)).resolves.toEqual(payload);
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
        expect(responseHeaders.getHeader('content-type')).toBe('text/plain');
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

        await adapter.commit({} as H3Event, {
            workspace_id: workspaceId,
            hash,
        });

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

        getActiveSyncGatewayAdapterMock.mockReturnValueOnce({
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
            reason: 'canonical_reference_state_required',
        });
        await expect(readFile(objectPath)).resolves.toEqual(payload);
        await expect(readFile(metadataPath)).resolves.toBeTruthy();
        expect(getActiveSyncGatewayAdapterMock).toHaveBeenCalledOnce();
    });
});

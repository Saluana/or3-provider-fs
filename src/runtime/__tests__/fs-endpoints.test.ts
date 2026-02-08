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

const requireCanMock = vi.hoisted(() => vi.fn());
const resolveSessionContextMock = vi.hoisted(() => vi.fn());

vi.mock('~~/server/auth/can', () => ({
    requireCan: requireCanMock as unknown,
}));

vi.mock('~~/server/auth/session', () => ({
    resolveSessionContext: resolveSessionContextMock as unknown,
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
    });

    afterEach(async () => {
        delete process.env.OR3_STORAGE_FS_ROOT;
        delete process.env.OR3_STORAGE_FS_TOKEN_SECRET;
        requireCanMock.mockReset();
        resolveSessionContextMock.mockReset();
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

        const stream = (await downloadHandler(event)) as unknown as NodeJS.ReadableStream;
        await expect(readNodeStream(stream)).resolves.toEqual(payload);
        const responseHeaders = (event as unknown as { res: { headers: Headers } }).res.headers;
        expect(responseHeaders.get('Content-Type')).toBe('text/plain');
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
});

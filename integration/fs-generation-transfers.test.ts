/** Actual dormant FS + SQLite composition. Only identity-provider resolution
 * is replaced; authorization, HTTP, quota, canonical reads and disk are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { createServer, request as nodeRequest } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, eventHandler, getHeader, readBody, toWebHandler, toNodeListener, type H3Event } from 'h3';
import hostPresignUpload from '~~/server/api/storage/presign-upload.post';
import hostCommit from '~~/server/api/storage/commit.post';
import hostPresignDownload from '~~/server/api/storage/presign-download.post';
import { resetSyncRateLimits } from '~~/server/utils/sync/rate-limiter';
import { _resetForTest, destroySqliteDb, getRawDb, initializeSqliteDb, type SqliteRawDatabase } from '../../sqlite/src/runtime/server/db/kysely';
import { runMigrations } from '../../sqlite/src/runtime/server/db/migrate';
import { SqliteExternalStorageGenerationUploadCoordinator } from '../../sqlite/src/runtime/server/storage/sqlite-generation-upload-coordinator';
import { SqliteSyncGatewayAdapter } from '../../sqlite/src/runtime/server/sync/sqlite-sync-gateway-adapter';
import { FsGenerationStore } from '../src/runtime/server/storage/fs-generations';
import { createFsGenerationGateway } from '../src/runtime/server/storage/fs-generation-gateway';
import { createFsGenerationTokenCodec } from '../src/runtime/server/storage/fs-generation-token';

vi.mock('~~/server/auth/session', () => ({
    resolveSessionContext: vi.fn(async (event: H3Event) => {
        const id = getHeader(event, 'x-test-user') ?? 'owner';
        return { authenticated: id !== 'anonymous', user: { id },
            role: getHeader(event, 'x-test-role') ?? 'owner',
            workspace: { id: getHeader(event, 'x-test-workspace') ?? 'workspace' } };
    }),
}));
vi.mock('~~/server/storage/gateway/registry', () => ({ getActiveStorageGatewayAdapter: () => gateway.adapter }));
vi.mock('~~/server/sync/gateway/registry', () => ({ getActiveSyncGatewayAdapter: () => sync }));

const data = Buffer.from('immutable authenticated upload bytes');
const hash = createHash('sha256').update(data).digest('hex');
const secret = 'test-only-generation-transfer-secret-at-least-32-bytes';
const input = { workspaceId: 'workspace', hash, mimeType: 'image/png', sizeBytes: data.length };
let directory: string;
let root: string;
let namespaceId: string;
let raw: SqliteRawDatabase;
let coordinator: SqliteExternalStorageGenerationUploadCoordinator;
let sync: SqliteSyncGatewayAdapter;
let store: FsGenerationStore;
let gateway: ReturnType<typeof createFsGenerationGateway>;
let fetchLocal: ReturnType<typeof toWebHandler>;
const children: ChildProcessWithoutNullStreams[] = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
async function signedDownload() {
    const result = await publish(); metadata(result);
    const response = await request('/download-presign', { workspaceId: 'workspace', hash });
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as { url: string };
}
type Presign = { url: string; storageId: string; intentId: string; expiresAt: number; headers: Record<string, string> };
function token(result: Presign) {
    return createFsGenerationTokenCodec({ secret, namespaceId, syncProviderId: 'sqlite' })
        .verify(new URL(result.url, 'http://localhost').searchParams.get('token')!, 'generation_upload');
}
function slot(result: Presign) { return join(root, 'generations-v1', 'workspaces', 'workspace', token(result).generationId); }
function commitBody(result: Presign) { return { workspace_id: 'workspace', hash, storage_id: result.storageId,
    intent_id: result.intentId, storage_provider_id: 'fs', mime_type: input.mimeType, size_bytes: data.length }; }
function metadata(result: Presign) {
    raw.prepare('INSERT INTO s_file_meta (workspace_id,id,data_json) VALUES (?,?,?)')
        .run('workspace', hash, JSON.stringify({ hash, storage_id: result.storageId, size_bytes: data.length, mime_type: input.mimeType, name: 'image.png', kind: 'image' }));
}
function charge() { return (raw.prepare("SELECT coalesce(sum(reserved_bytes),0) AS total FROM upload_intents WHERE status='active'").get() as { total: number }).total; }
async function request(path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') {
    return fetchLocal(new Request('http://localhost' + path, { method,
        headers: { host: 'localhost', origin: 'http://localhost', 'x-or3-cloud-intent': 'mutation',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : body instanceof Uint8Array ? new Uint8Array(body).buffer : typeof body === 'string' ? body : JSON.stringify(body) }));
}
async function presign(extra: Record<string, unknown> = {}) {
    const response = await request('/presign', { ...input, ...extra });
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as Presign;
}
async function upload(result: Presign, bytes = data, headers: Record<string, string> = {}) {
    return request(result.url, bytes, { ...result.headers, 'content-type': input.mimeType, ...headers }, 'PUT');
}
async function publish() {
    const result = await presign();
    expect((await upload(result)).status).toBe(200);
    const committed = await request('/commit', commitBody(result));
    expect(committed.status, await committed.clone().text()).toBe(200);
    return result;
}

beforeEach(async () => {
    _resetForTest();
    directory = await mkdtemp(join(tmpdir(), 'or3-authenticated-generation-'));
    root = join(directory, 'files'); await mkdir(root);
    namespaceId = randomUUID();
    const db = await initializeSqliteDb({ path: join(directory, 'db.sqlite'), driver: 'bun', journalMode: 'WAL', synchronous: 'FULL' });
    await runMigrations(db); raw = getRawDb();
    vi.stubGlobal('useRuntimeConfig', () => ({ auth: { enabled: true }, storage: { enabled: true }, public: {},
        security: { proxy: { trustProxy: false }, allowedOrigins: [] } }));
    coordinator = new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 'fs' });
    sync = new SqliteSyncGatewayAdapter();
    store = new FsGenerationStore(root, namespaceId); await store.provision();
    gateway = createFsGenerationGateway({ enabled: true, resolve: () => ({ store, coordinator, sync, namespaceId, syncProviderId: 'sqlite', tokenSecret: secret, uploadLifetimeSeconds: 2 }) });
    const app = createApp({ debug: true });
    app.use('/presign', eventHandler(event => readBody(event).then(body => gateway.adapter.presignUpload(event, body))));
    app.use('/commit', eventHandler(async event => { await gateway.adapter.commit!(event, await readBody(event)); return { ok: true }; }));
    app.use('/download-presign', eventHandler(event => readBody(event).then(body => gateway.adapter.presignDownload(event, body))));
    app.use('/api/storage/fs/generations/upload', gateway.upload);
    app.use('/api/storage/fs/generations/download', gateway.download);
    app.use('/host/presign-upload', hostPresignUpload);
    app.use('/host/commit', hostCommit);
    app.use('/host/presign-download', hostPresignDownload);
    fetchLocal = toWebHandler(app);
});
afterEach(async () => {
    for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
        }
    }
    resetSyncRateLimits();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (raw?.inTransaction) raw.exec('ROLLBACK');
    await destroySqliteDb(); await rm(directory, { recursive: true, force: true });
});

describe('authenticated immutable generation transport with SQLite', () => {
    it.each(['abort', 'expiry'])('owns %s errors before the filesystem starts consuming the upload body', async mode => {
        const result = await presign();
        const reached = deferred(); const resume = deferred();
        const publishBytes = store.publish.bind(store);
        vi.spyOn(store, 'publish').mockImplementation(async (spec, bytes) => { reached.resolve(); await resume.promise; return publishBytes(spec, bytes); });
        const controller = new AbortController();
        const pending = fetchLocal(new Request('http://localhost' + result.url, { method: 'PUT', body: new Uint8Array(data).buffer,
            headers: { host: 'localhost', origin: 'http://localhost', ...result.headers, 'content-type': input.mimeType }, signal: controller.signal }));
        await reached.promise;
        if (mode === 'abort') controller.abort();
        else await new Promise(resolve => setTimeout(resolve, 2100));
        await new Promise(resolve => setTimeout(resolve, 10));
        resume.resolve();
        expect((await pending).status).toBeGreaterThanOrEqual(400);
        expect(await coordinator.getGeneration({ ...input, generationId: result.storageId.split(':')[3]! })).toBeNull();
    });

    it.each([0, 2 * 1024 * 1024])('bounds unread web response buffering and closes %s-byte files', async size => {
        const bytes = Buffer.alloc(size, 1);
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        const result = await presign({ hash: contentHash, sizeBytes: size });
        expect((await (size === 0
            ? request(result.url, undefined, { ...result.headers, 'content-type': input.mimeType }, 'PUT')
            : upload(result, bytes))).status).toBe(200);
        expect((await request('/commit', { ...commitBody(result), hash: contentHash, size_bytes: size })).status).toBe(200);
        raw.prepare('INSERT INTO s_file_meta (workspace_id,id,data_json) VALUES (?,?,?)')
            .run('workspace', contentHash, JSON.stringify({ hash: contentHash, storage_id: result.storageId, size_bytes: size, mime_type: input.mimeType }));
        const signed = await request('/download-presign', { workspaceId: 'workspace', hash: contentHash });
        const open = store.openPublication.bind(store);
        let file: FileHandle | undefined;
        let reads: { mock: { calls: unknown[][] } } | undefined;
        vi.spyOn(store, 'openPublication').mockImplementation(async spec => { file = await open(spec); reads = vi.spyOn(file, 'read'); return file; });
        const response = await request((await signed.json() as { url: string }).url);
        expect(response.status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(reads?.mock.calls.length).toBeLessThanOrEqual(4);
        if (size === 0) expect((await response.arrayBuffer()).byteLength).toBe(0);
        else await response.body!.cancel();
        await expect.poll(() => file?.fd).toBe(-1);
    });

    it('composes the real host control routes, MIME/body guards, immutable PUT and authorized GET', async () => {
        const body = { workspace_id: 'workspace', hash, mime_type: input.mimeType, size_bytes: data.length };
        expect((await request('/host/presign-upload', { ...body, mime_type: 'application/x-unknown' })).status).toBe(415);
        expect((await request('/host/commit', 'x'.repeat(20_000))).status).toBe(413);
        expect((await request('/host/presign-upload', body, { origin: 'https://foreign.example' })).status).toBe(403);
        expect(charge()).toBe(0);
        const response = await request('/host/presign-upload', body);
        expect(response.status, await response.clone().text()).toBe(200);
        const result = await response.json() as Presign;
        expect((await upload(result)).status).toBe(200);
        const committed = await request('/host/commit', { ...commitBody(result), kind: 'image', name: 'image.png' });
        expect(committed.status, await committed.clone().text()).toBe(200);
        metadata(result);
        const signed = await request('/host/presign-download', { workspace_id: 'workspace', hash });
        expect(signed.status, await signed.clone().text()).toBe(200);
        const download = await signed.json() as { url: string };
        const received = await request(download.url);
        expect(Buffer.from(await received.arrayBuffer())).toEqual(data);
    });

    it('closes the descriptor when a web response body is cancelled', async () => {
        const signed = await signedDownload();
        const open = store.openPublication.bind(store);
        let file: FileHandle | undefined;
        vi.spyOn(store, 'openPublication').mockImplementation(async spec => { file = await open(spec); return file; });
        const response = await request(signed.url);
        expect(response.status).toBe(200);
        await response.body!.cancel();
        await expect.poll(() => file?.fd).toBe(-1);
    });

    it('closes a web download aborted while byte verification was in progress', async () => {
        const signed = await signedDownload();
        const open = store.openPublication.bind(store);
        const opened = deferred(); const resume = deferred();
        let file: FileHandle | undefined;
        vi.spyOn(store, 'openPublication').mockImplementation(async spec => { file = await open(spec); opened.resolve(); await resume.promise; return file; });
        const controller = new AbortController();
        const pending = fetchLocal(new Request('http://localhost' + signed.url, { signal: controller.signal }));
        await opened.promise; controller.abort(); resume.resolve();
        expect((await pending).status).toBe(499);
        expect(file?.fd).toBe(-1);
    });

    it('closes a real Node HTTP download when its client disconnects before transfer', async () => {
        const signed = await signedDownload();
        const open = store.openPublication.bind(store);
        const opened = deferred(); const resume = deferred();
        let file: FileHandle | undefined;
        vi.spyOn(store, 'openPublication').mockImplementation(async spec => { file = await open(spec); opened.resolve(); await resume.promise; return file; });
        const app = createApp(); app.use('/api/storage/fs/generations/download', gateway.download);
        const server = createServer(toNodeListener(app));
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
            const client = nodeRequest(`http://127.0.0.1:${address.port}${signed.url}`);
            client.on('error', () => {}); client.end();
            await opened.promise;
            const closed = new Promise(resolve => client.once('close', resolve));
            client.destroy(); await closed;
            await new Promise(resolve => setTimeout(resolve, 10));
            resume.resolve();
            await expect.poll(() => file?.fd).toBe(-1);
        } finally { resume.resolve(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    });

    it.each(['slot_created', 'ready_written'])('recovers a real allocator process killed at %s without inventing pre-ready proof', async phase => {
        const spec = { ...input, generationId: randomUUID(), intentId: randomUUID(), userId: 'owner' };
        await coordinator.reserveGenerationUpload({ ...spec, namespaceId, storageId: store.storageId(spec), expiresInSeconds: 1 });
        const child = spawn('bun', [fileURLToPath(new URL('../test/fixtures/fs-generation-worker.ts', import.meta.url)),
            'allocate', root, namespaceId, JSON.stringify(spec), phase], { stdio: 'pipe' });
        children.push(child);
        const lines = createInterface({ input: child.stdout });
        const line = await lines[Symbol.asyncIterator]().next();
        expect(JSON.parse(line.value!).event).toBe('paused');
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; lines.close();
        await new Promise(resolve => setTimeout(resolve, 1100));
        const recovered = await gateway.recover({ workspaceId: 'workspace', retentionSeconds: 0 });
        if (phase === 'slot_created') {
            expect(recovered.items[0]).toMatchObject({ status: 'retained', reason: 'pre_ready_unknown' });
            expect((await store.allocate(spec)).status).toBe('incomplete');
            expect(charge()).toBe(data.length);
        } else {
            expect(recovered.items[0]?.status).toBe('abandoned');
            expect((await store.allocate(spec)).status).toBe('payload_missing');
            expect(charge()).toBe(0);
        }
    });

    it('publishes real bytes, holds source-first quota, materializes, and streams to another authorized reader', async () => {
        const result = await publish();
        const claims = token(result);
        expect((await coordinator.getGenerationUpload({ ...claims, intentId: result.intentId }))?.state).toBe('published_pending_metadata');
        raw.prepare('INSERT INTO s_messages (workspace_id,id,data_json) VALUES (?,?,?)').run('workspace', 'source', JSON.stringify({ file_hashes: [hash] }));
        await new Promise(resolve => setTimeout(resolve, 2100));
        expect(charge()).toBe(data.length);
        expect((await gateway.recover({ workspaceId: 'workspace', retentionSeconds: 0 })).items[0]?.status).toBe('retained');
        metadata(result);
        expect(charge()).toBe(0);
        const signed = await request('/download-presign', { workspaceId: 'workspace', hash }, { 'x-test-user': 'reader', 'x-test-role': 'viewer' });
        expect(signed.status, await signed.clone().text()).toBe(200);
        const download = await signed.json() as { url: string };
        const response = await request(download.url, undefined, { 'x-test-user': 'reader', 'x-test-role': 'viewer' });
        expect(response.status).toBe(200);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        // h3's web adapter resolves sendStream before the response is consumed.
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
        expect((await request(download.url)).status).toBe(403);
    });

    it('refuses anonymous, foreign workspace, viewer write and changed upload subject before bytes', async () => {
        for (const headers of [{ 'x-test-user': 'anonymous' }, { 'x-test-role': 'viewer' }, { 'x-test-workspace': 'other' }] as Record<string, string>[]) {
            expect((await request('/presign', input, headers)).status).toBeGreaterThanOrEqual(400);
        }
        expect(charge()).toBe(0);
        const result = await presign();
        expect((await upload(result, data, { 'x-test-user': 'another' })).status).toBe(403);
        expect((await upload(result, data, { origin: 'https://foreign.example' })).status).toBe(403);
        expect((await readdir(join(slot(result), 'payload')))).toEqual([]);
    });

    it('requires fresh write authorization at commit after an upload role is revoked', async () => {
        const result = await presign(); expect((await upload(result)).status).toBe(200);
        expect((await request('/commit', commitBody(result), { 'x-test-role': 'viewer' })).status).toBe(403);
        expect(await coordinator.getGeneration(token(result))).toBeNull();
        expect(await readFile(join(slot(result), 'payload/blob'))).toEqual(data);
    });

    it.each([{ intent_id: randomUUID() }, { storage_provider_id: 's3' }, { mime_type: 'text/plain' },
        { size_bytes: data.length + 1 }, { hash: 'b'.repeat(64) }, { storage_id: 'workspace:legacy' }])('rejects altered commit binding %j', async change => {
        const result = await presign(); expect((await upload(result)).status).toBe(200);
        expect((await request('/commit', { ...commitBody(result), ...change })).status).toBeGreaterThanOrEqual(400);
        expect(await coordinator.getGeneration(token(result))).toBeNull();
    });

    it('rehashes bytes at commit and rejects truncated or wrong digest uploads', async () => {
        const result = await presign();
        expect((await upload(result, data.subarray(1))).status).toBeGreaterThanOrEqual(400);
        expect((await upload(result, Buffer.alloc(data.length))).status).toBeGreaterThanOrEqual(400);
        expect(await coordinator.getGeneration(token(result))).toBeNull();
        expect((await upload(result)).status).toBe(200);
        expect((await request('/commit', commitBody(result))).status).toBe(200);
        expect((await request('/commit', commitBody(result))).status).toBe(200);
    });

    it('reclaims only an expired ready allocation and refuses its old credential after a successor reservation', async () => {
        const result = await presign(); const path = slot(result); const old = token(result);
        expect((await upload(result)).status).toBe(200); await new Promise(resolve => setTimeout(resolve, 2100));
        expect((await gateway.recover({ workspaceId: 'workspace', retentionSeconds: 0 })).items[0]?.status).toBe('abandoned');
        expect(await stat(path)).toBeDefined();
        await expect(stat(join(path, 'payload'))).rejects.toMatchObject({ code: 'ENOENT' });
        const successor = await presign(); expect(successor.storageId).not.toBe(result.storageId);
        expect((await upload(result)).status).toBe(403);
        expect((await upload(successor)).status).toBe(200);
        expect((await store.allocate(old)).status).toBe('payload_missing');
        expect(await readFile(join(slot(successor), 'payload/blob'))).toEqual(data);
    });

    it('keeps pre-ready slots and their quota, then reconciles a late durable receipt without extending credentials', async () => {
        const spec = { ...input, generationId: randomUUID(), intentId: randomUUID(), userId: 'owner' };
        await coordinator.reserveGenerationUpload({ ...spec, namespaceId, storageId: store.storageId(spec), expiresInSeconds: 1 });
        await new Promise(resolve => setTimeout(resolve, 1100));
        expect((await gateway.recover({ workspaceId: 'workspace', retentionSeconds: 0 })).items[0]).toMatchObject({ status: 'retained', reason: 'pre_ready_unknown' });
        expect(charge()).toBe(data.length);
        await store.allocate(spec);
        expect((await gateway.recover({ workspaceId: 'workspace', retentionSeconds: 0 })).items[0]?.status).toBe('abandoned');
        expect((await store.allocate(spec)).status).toBe('payload_missing');
    });

    it('reports lost presign response as a held reservation rather than pretending a new request replays it', async () => {
        const first = await presign();
        expect((await request('/presign', input)).status).toBeGreaterThanOrEqual(400);
        expect(charge()).toBe(data.length);
        await new Promise(resolve => setTimeout(resolve, 2100));
        expect((await gateway.recover({ workspaceId: 'workspace', retentionSeconds: 0 })).items[0]?.intentId).toBe(first.intentId);
        expect((await presign()).storageId).not.toBe(first.storageId);
    });

    it('clamps subsecond TTL and rejects mismatched namespace configuration before any allocation', async () => {
        const bad = createFsGenerationGateway({ enabled: true, resolve: () => ({ store, coordinator, sync, namespaceId: randomUUID(), syncProviderId: 'sqlite', tokenSecret: secret }) });
        await expect(bad.adapter.presignUpload({} as H3Event, input)).rejects.toThrow(/namespace/);
        expect(charge()).toBe(0);
        const before = Math.floor(Date.now() / 1000);
        const result = await presign({ expiresInMs: 1 });
        expect(result.expiresAt).toBeGreaterThanOrEqual((before + 1) * 1000);
        expect(result.expiresAt).toBeLessThanOrEqual((Math.floor(Date.now() / 1000) + 1) * 1000);
    });

    it('refuses a previously signed download after canonical metadata tombstone', async () => {
        const result = await publish(); metadata(result);
        const signed = await request('/download-presign', { workspaceId: 'workspace', hash });
        const download = await signed.json() as { url: string };
        raw.exec('UPDATE s_file_meta SET deleted=1');
        expect((await request(download.url)).status).toBe(404);
    });

    it.each(['text/html', 'image/svg+xml'])('keeps %s and unsafe filenames inert in real host downloads', async mimeType => {
        const result = await publish(); metadata(result);
        raw.prepare('UPDATE s_file_meta SET data_json=?').run(JSON.stringify({ hash, storage_id: result.storageId,
            size_bytes: data.length, mime_type: mimeType, kind: 'file', name: '../evil\r\n<script>.svg' }));
        const signed = await request('/host/presign-download', { workspace_id: 'workspace', hash,
            disposition: 'inline', file_kind_capability: 'v1' });
        expect(signed.status, await signed.clone().text()).toBe(200);
        const response = await request((await signed.json() as { url: string }).url);
        expect(response.headers.get('content-type')).toBe('application/octet-stream');
        expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
        expect(response.headers.get('content-disposition')).not.toMatch(/[\r\n]/);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    });

    it('preserves an explicit attachment disposition even for safe inline MIME', async () => {
        const result = await publish(); metadata(result);
        const signed = await request('/host/presign-download', { workspace_id: 'workspace', hash, disposition: 'attachment' });
        const response = await request((await signed.json() as { url: string }).url);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
        await response.arrayBuffer();
    });

    it('refuses restore tickets for bytes while allowing their qualified expired abandonment', async () => {
        const result = await publish(); const claims = token(result); const path = slot(result);
        metadata(result); raw.exec('UPDATE s_file_meta SET deleted=1');
        const restoreKey = { ...claims, intentId: randomUUID() };
        const restored = await coordinator.reserveGenerationRestore({ ...restoreKey, expiresInSeconds: 1 });
        expect(restored.intent.purpose).toBe('restore');
        const tokenValue = createFsGenerationTokenCodec({ secret, namespaceId, syncProviderId: 'sqlite' })
            .sign({ ...claims, intentId: restoreKey.intentId }, 'generation_upload', restored.intent.expiresAt);
        expect((await request('/api/storage/fs/generations/upload?token=' + encodeURIComponent(tokenValue), data,
            { 'content-type': input.mimeType }, 'PUT')).status).toBe(409);
        expect((await request('/commit', { ...commitBody(result), intent_id: restoreKey.intentId })).status).toBe(409);
        await new Promise(resolve => setTimeout(resolve, 1100));
        const recovery = await gateway.recover({ workspaceId: 'workspace', retentionSeconds: 0 });
        expect(recovery.items.find(item => item.intentId === restoreKey.intentId)?.status).toBe('abandoned');
        await expect(stat(join(path, 'payload'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(charge()).toBe(0);
    });

    it('fences a real PUT paused before publication after expiry and exact abandonment', async () => {
        const paused = deferred(); const resume = deferred();
        store = new FsGenerationStore(root, namespaceId, { checkpoint: async phase => {
            if (phase === 'before_blob_publish') { paused.resolve(); await resume.promise; }
        } });
        const result = await presign(); const path = slot(result);
        const pending = upload(result);
        await paused.promise;
        await new Promise(resolve => setTimeout(resolve, 2100));
        expect((await gateway.recover({ workspaceId: 'workspace', retentionSeconds: 0 })).items[0]?.status).toBe('abandoned');
        resume.resolve();
        expect((await pending).status).toBeGreaterThanOrEqual(400);
        await expect(stat(join(path, 'payload'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await coordinator.getGeneration({ ...input, generationId: result.storageId.split(':')[3]! })).toBeNull();
    });

    it('refuses abandonment unlink from an outer transaction or unsafe durability settings', async () => {
        const result = await presign({ expiresInMs: 1000 }); const claims = token(result); const path = slot(result);
        expect((await upload(result)).status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 1100));
        const claimKey = { ...claims, intentId: result.intentId, claimId: randomUUID() };
        expect((await coordinator.claimAbandonedGenerationUpload({ ...claimKey, retentionSeconds: 0 })).status).toBe('claimed');
        raw.exec('BEGIN IMMEDIATE');
        await expect(store.removeAbandoned(claimKey, claimKey.claimId, coordinator)).rejects.toThrow();
        raw.exec('ROLLBACK');
        raw.exec('PRAGMA synchronous=NORMAL');
        await expect(store.removeAbandoned(claimKey, claimKey.claimId, coordinator)).rejects.toThrow();
        expect(await readFile(join(path, 'payload/blob'))).toEqual(data);
        raw.exec('PRAGMA synchronous=FULL');
        expect((await gateway.recover({ workspaceId: 'workspace', retentionSeconds: 0 })).items[0]?.status).toBe('abandoned');
    });
});

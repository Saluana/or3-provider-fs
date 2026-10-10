/** Explicitly constructed, default-disabled generation transport. This module
 * is deliberately outside server/api and is never registered by the provider.
 * Host control routes remain responsible for their MIME policy/rate limits.
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FileHandle } from 'node:fs/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createError, eventHandler, getHeader, getQuery, sendStream, setResponseHeader } from 'h3';
import type { H3Event } from 'h3';
import { requireCan } from '~~/server/auth/can';
import { resolveSessionContext } from '~~/server/auth/session';
import { requireSameOriginMutation } from '~~/server/utils/security/mutation-guard';
import { resolveDownloadPolicy } from '~~/server/utils/storage/download-policy';
import { requireExternalStorageGenerationUploadCoordinator } from '~~/server/utils/storage/generation-upload-coordination';
import type { StorageGatewayAdapter } from '~~/server/storage/gateway/types';
import type { CanonicalStorageMetadataRecord, SyncGatewayAdapter } from '~~/server/sync/gateway/types';
import type { ExternalStorageGenerationUploadIntent, ExternalStorageGenerationUploadKey } from '~~/server/storage/gateway/generation-upload';
import { createFsGenerationTokenCodec, type FsGenerationTokenClaims } from './fs-generation-token';
import { FsGenerationStore, type FsGenerationSpec } from './fs-generations';
import { parseFsHash } from './fs-hash';

export interface FsGenerationDependencies {
    store: FsGenerationStore;
    coordinator: unknown;
    /** The currently selected canonical reader, resolved per request. */
    sync: Pick<SyncGatewayAdapter, 'id' | 'queryCanonicalStorage'>;
    namespaceId: string;
    syncProviderId: string;
    tokenSecret: string;
    maxUploadBytes?: number;
    uploadLifetimeSeconds?: number;
}
type RecoveryInput = { workspaceId: string; retentionSeconds: number; cursor?: string; limit?: number };
type RecoveryItem = { intentId: string; generationId: string; status: string; reason?: string };
const clock = () => Math.floor(Date.now() / 1000);
function fail(statusCode: number, statusMessage: string): never { throw createError({ statusCode, statusMessage }); }
function hash(value: string): string {
    const parsed = parseFsHash(value);
    if (parsed?.algorithm !== 'sha256') fail(400, 'A SHA-256 identity is required');
    return parsed.canonical;
}
function key(intent: ExternalStorageGenerationUploadIntent): ExternalStorageGenerationUploadKey {
    return { workspaceId: intent.workspaceId, hash: intent.hash, generationId: intent.generationId,
        intentId: intent.intentId, userId: intent.userId };
}
function bodyStream(event: H3Event): Readable | null {
    if (event.web?.request) {
        const web = event.web.request.body;
        // A real null web body is an empty upload, not h3's Node request shim.
        return web ? Readable.fromWeb(web as NodeReadableStream) : Readable.from([]);
    }
    if (typeof event.node?.req?.pipe === 'function') return event.node.req;
    const body = (event as unknown as { req?: { body?: NodeReadableStream | null } }).req?.body;
    return body ? Readable.fromWeb(body) : null;
}
/** Descriptor ownership independent of FileHandle.createReadStream's runtime
 * reference counting. _destroy also closes a stream cancelled before any read.
 */
function publicationStream(handle: FileHandle, sizeBytes: number): Readable {
    let position = 0;
    return new Readable({
        autoDestroy: true,
        highWaterMark: 64 * 1024,
        read() {
            if (position === sizeBytes) { this.push(null); return; }
            const buffer = Buffer.alloc(Math.min(64 * 1024, sizeBytes - position));
            void handle.read(buffer, 0, buffer.length, position).then(({ bytesRead }) => {
                if (bytesRead === 0) { this.destroy(new Error('Published file truncated')); return; }
                position += bytesRead;
                this.push(buffer.subarray(0, bytesRead));
            }, error => this.destroy(error));
        },
        destroy(error, callback) {
            void handle.close().then(() => callback(error), closeError => callback(error ?? closeError));
        },
    });
}
async function user(event: H3Event, workspaceId: string, permission: 'workspace.read' | 'workspace.write', expected?: string): Promise<string> {
    const session = await resolveSessionContext(event);
    if (!session.authenticated || !session.user) fail(401, 'Unauthorized');
    if (expected !== undefined && session.user.id !== expected) fail(403, 'Invalid credential subject');
    requireCan(session, permission, { kind: 'workspace', id: workspaceId });
    return session.user.id;
}

export function createFsGenerationGateway(options: { enabled?: boolean; resolve: () => FsGenerationDependencies }) {
    function dependencies() {
        // Must precede every request, body, token, auth, database and FS access.
        if (options.enabled !== true) fail(404, 'Not Found');
        const deps = options.resolve();
        deps.store.assertNamespace(deps.namespaceId);
        const coordinator = requireExternalStorageGenerationUploadCoordinator(deps.coordinator, 'fs');
        if (deps.sync?.id !== deps.syncProviderId || typeof deps.sync.queryCanonicalStorage !== 'function') fail(503, 'Canonical provider pair unavailable');
        const maxBytes = deps.maxUploadBytes ?? 100 * 1024 * 1024;
        const lifetime = deps.uploadLifetimeSeconds ?? 300;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 900) fail(503, 'Invalid generation limits');
        const codec = createFsGenerationTokenCodec({ secret: deps.tokenSecret, namespaceId: deps.namespaceId, syncProviderId: deps.syncProviderId });
        return { ...deps, coordinator, codec, maxBytes, lifetime };
    }
    type Dependencies = ReturnType<typeof dependencies>;
    function binding(deps: Dependencies, intent: ExternalStorageGenerationUploadIntent, expected: FsGenerationSpec & { userId: string; intentId: string; mimeType: string; expiresAt?: number }) {
        if (intent.storageProviderId !== 'fs' || intent.namespaceId !== deps.namespaceId ||
            intent.storageId !== deps.store.storageId(expected) || intent.workspaceId !== expected.workspaceId ||
            intent.userId !== expected.userId || intent.intentId !== expected.intentId || intent.generationId !== expected.generationId ||
            hash(intent.hash) !== hash(expected.hash) || intent.sizeBytes !== expected.sizeBytes || intent.mimeType !== expected.mimeType ||
            (expected.expiresAt !== undefined && intent.expiresAt !== expected.expiresAt)) fail(409, 'Generation binding mismatch');
    }
    function credential(event: H3Event, deps: Dependencies, operation: 'generation_upload' | 'generation_download'): FsGenerationTokenClaims {
        const token = getQuery(event).token;
        try { return deps.codec.verify(typeof token === 'string' ? token : '', operation); }
        catch { return fail(403, 'Invalid or expired generation credential'); }
    }
    async function live(deps: Dependencies, event: H3Event, workspaceId: string, targetHash: string, storageId?: string): Promise<{ metadata: CanonicalStorageMetadataRecord; spec: FsGenerationSpec }> {
        const canonicalHash = hash(targetHash);
        const page = await deps.sync.queryCanonicalStorage!(event, { scope: { workspaceId }, kind: 'live_metadata', hash: canonicalHash, limit: 2 });
        // A duplicate/partial answer is ambiguous authorization, never a best guess.
        if (page.hasMore || page.items.length !== 1) fail(404, 'File not found');
        const metadata = page.items[0];
        if (metadata?.kind !== 'metadata' || (metadata as { deleted?: unknown }).deleted === true ||
            hash(metadata.hash) !== canonicalHash || typeof metadata.storageId !== 'string' ||
            !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 0 ||
            (storageId !== undefined && metadata.storageId !== storageId)) fail(404, 'File not found');
        const spec = deps.store.resolveStorageId(metadata.storageId, workspaceId, canonicalHash, metadata.sizeBytes);
        const generation = await deps.coordinator.getGeneration(spec);
        if (!generation || generation.state !== 'verified' || generation.workspaceId !== workspaceId ||
            generation.generationId !== spec.generationId || hash(generation.hash) !== canonicalHash ||
            generation.sizeBytes !== spec.sizeBytes || generation.storageId !== metadata.storageId) fail(404, 'File not found');
        return { metadata, spec };
    }
    const adapter: StorageGatewayAdapter = {
        id: 'fs',
        async presignUpload(event, input) {
            const deps = dependencies();
            const userId = await user(event, input.workspaceId, 'workspace.write');
            if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > deps.maxBytes) fail(413, 'Invalid upload size');
            const spec = { workspaceId: input.workspaceId, hash: hash(input.hash), generationId: randomUUID(), sizeBytes: input.sizeBytes };
            const identity = { ...spec, userId, intentId: randomUUID(), mimeType: input.mimeType };
            const ttl = input.expiresInMs === undefined ? deps.lifetime : Math.min(deps.lifetime, Math.max(1, Math.floor(input.expiresInMs / 1000)));
            // Validate the complete token identity before allocating anything.
            deps.codec.sign(identity, 'generation_upload', clock() + ttl);
            const storageId = deps.store.storageId(spec);
            const reserved = await deps.coordinator.reserveGenerationUpload({ ...identity, storageId,
                namespaceId: deps.namespaceId, expiresInSeconds: ttl, workspaceQuotaBytes: input.workspaceQuotaBytes });
            binding(deps, reserved.intent, identity);
            if (reserved.intent.purpose !== 'upload' || reserved.intent.state !== 'reserved' || reserved.intent.expiresAt <= clock()) fail(409, 'Upload reservation unavailable');
            await deps.store.allocate(spec);
            const ready = await deps.store.inspectAllocation(spec);
            if (ready.status !== 'ready') fail(409, 'Allocation is incomplete or retired');
            const marked = await deps.coordinator.markGenerationUploadReady({ ...key(reserved.intent), storageId, readyReceiptId: ready.receipt.readyReceiptId });
            binding(deps, marked.intent, identity);
            if (marked.intent.purpose !== 'upload' || marked.intent.state !== 'ready' || marked.intent.readyReceiptId !== ready.receipt.readyReceiptId) fail(409, 'Upload readiness mismatch');
            const token = deps.codec.sign(identity, 'generation_upload', marked.intent.expiresAt);
            return { url: `/api/storage/fs/generations/upload?token=${encodeURIComponent(token)}`, method: 'PUT',
                headers: { 'x-or3-cloud-intent': 'mutation' }, expiresAt: marked.intent.expiresAt * 1000, storageId, intentId: identity.intentId };
        },
        async commit(event, input) {
            const deps = dependencies();
            if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Invalid commit input');
            const body = input as Record<string, unknown>;
            if (typeof body.workspace_id !== 'string' || typeof body.hash !== 'string' || typeof body.storage_id !== 'string' ||
                typeof body.intent_id !== 'string' || body.storage_provider_id !== 'fs' || typeof body.mime_type !== 'string' ||
                typeof body.size_bytes !== 'number') fail(400, 'Invalid generation commit');
            const userId = await user(event, body.workspace_id, 'workspace.write');
            const spec = deps.store.resolveStorageId(body.storage_id, body.workspace_id, body.hash, body.size_bytes);
            const expected = { ...spec, userId, intentId: body.intent_id, mimeType: body.mime_type };
            const intent = await deps.coordinator.getGenerationUpload(expected);
            if (!intent) fail(404, 'Upload intent not found');
            binding(deps, intent, expected);
            if (intent.purpose !== 'upload' || intent.expiresAt <= clock() || !['ready', 'published_pending_metadata', 'materialized'].includes(intent.state)) fail(409, 'Upload intent unavailable');
            const receipt = await deps.store.verifyPublication(spec);
            if (receipt.readyReceiptId !== intent.readyReceiptId) fail(409, 'Upload readiness mismatch');
            const result = await deps.coordinator.publishGenerationUpload({ ...key(intent), storageId: receipt.storageId, sizeBytes: receipt.sizeBytes, readyReceiptId: receipt.readyReceiptId });
            binding(deps, result.intent, expected);
            if (result.generation.state !== 'verified' || result.generation.storageId !== receipt.storageId ||
                !['published_pending_metadata', 'materialized'].includes(result.intent.state)) fail(409, 'Generation publication unavailable');
        },
        async presignDownload(event, input) {
            const deps = dependencies();
            const userId = await user(event, input.workspaceId, 'workspace.read');
            const target = await live(deps, event, input.workspaceId, input.hash, input.storageId);
            const expiresAt = clock() + Math.min(deps.lifetime, input.expiresInMs === undefined ? deps.lifetime : Math.max(1, Math.floor(input.expiresInMs / 1000)));
            const policy = resolveDownloadPolicy({ fileKind: target.metadata.fileKind, mimeType: target.metadata.mimeType,
                requestedDisposition: input.disposition === 'attachment' ? 'attachment' : 'inline' });
            const token = deps.codec.sign({ ...target.spec, userId, mimeType: target.metadata.mimeType ?? 'application/octet-stream', disposition: policy.disposition }, 'generation_download', expiresAt);
            return { url: `/api/storage/fs/generations/download?token=${encodeURIComponent(token)}`, method: 'GET', expiresAt: expiresAt * 1000, storageId: target.metadata.storageId };
        },
    };
    const upload = eventHandler(async event => {
        const deps = dependencies();
        if (event.method !== 'PUT') fail(405, 'Method not allowed');
        const claims = credential(event, deps, 'generation_upload');
        await user(event, claims.workspaceId, 'workspace.write', claims.userId);
        requireSameOriginMutation(event, { intentHeader: 'x-or3-cloud-intent', intentValue: 'mutation', allowConfiguredOrigins: true, allowOriginlessBearer: true });
        if (getHeader(event, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== claims.mimeType) fail(415, 'Content type mismatch');
        if (claims.sizeBytes > deps.maxBytes) fail(413, 'Payload too large');
        const expected = { ...claims, intentId: claims.intentId! };
        const intent = await deps.coordinator.getGenerationUpload(expected);
        if (!intent) fail(404, 'Upload intent not found');
        binding(deps, intent, expected);
        if (intent.purpose !== 'upload' || intent.state !== 'ready' || intent.expiresAt <= clock()) fail(409, 'Upload intent unavailable');
        const ready = await deps.store.inspectAllocation(claims);
        if (ready.status !== 'ready' || ready.receipt.readyReceiptId !== intent.readyReceiptId) fail(409, 'Upload readiness mismatch');
        const stream = bodyStream(event);
        if (!stream) fail(400, 'Missing upload body');
        // publish opens/syncs directories before it starts the body iterator.
        // Abort/timeout errors during that gap still need an owner; retain the
        // listener through close, and never convert a captured error to success.
        let streamFailure: Error | undefined;
        const captureError = (error: Error) => { streamFailure ??= error; };
        stream.on('error', captureError);
        stream.once('close', () => stream.off('error', captureError));
        const timer = setTimeout(() => stream.destroy(createError({ statusCode: 408, statusMessage: 'Upload expired' })), Math.max(1, (claims.expiresAt - clock()) * 1000));
        timer.unref();
        const abort = () => { stream.destroy(createError({ statusCode: 499, statusMessage: 'Upload cancelled' })); };
        event.web?.request?.signal.addEventListener('abort', abort, { once: true });
        event.node.req.once('aborted', abort);
        try {
            if (event.web?.request?.signal.aborted || event.node.req.aborted) abort();
            await deps.store.publish(claims, stream);
            if (streamFailure) throw streamFailure;
            const current = await deps.coordinator.getGenerationUpload(expected);
            if (!current) fail(409, 'Upload intent unavailable');
            binding(deps, current, expected);
            if (current.state !== 'ready' || current.expiresAt <= clock()) fail(409, 'Upload expired or retired');
        } finally {
            clearTimeout(timer);
            event.web?.request?.signal.removeEventListener('abort', abort);
            event.node.req.off('aborted', abort);
            if (!stream.destroyed && !stream.readableEnded) stream.destroy();
        }
        // Canonical publication requires a separate authenticated commit and
        // independent byte verification. A request-cached session is not a
        // second membership lookup, and is never described as one here.
        return { ok: true, storage_id: deps.store.storageId(claims), intent_id: claims.intentId };
    });
    const download = eventHandler(async event => {
        const deps = dependencies();
        if (event.method !== 'GET') fail(405, 'Method not allowed');
        const claims = credential(event, deps, 'generation_download');
        await user(event, claims.workspaceId, 'workspace.read', claims.userId);
        const target = await live(deps, event, claims.workspaceId, claims.hash, deps.store.storageId(claims));
        if (target.spec.generationId !== claims.generationId || target.spec.sizeBytes !== claims.sizeBytes ||
            (target.metadata.mimeType ?? 'application/octet-stream') !== claims.mimeType) fail(404, 'File not found');
        const handle = await deps.store.openPublication(claims);
        let stream: Readable | undefined;
        try {
            if (event.web?.request?.signal.aborted || event.node.res.destroyed) fail(499, 'Download cancelled');
            const policy = resolveDownloadPolicy({ fileKind: target.metadata.fileKind, mimeType: target.metadata.mimeType,
                filename: target.metadata.name, requestedDisposition: claims.disposition });
            setResponseHeader(event, 'Content-Type', policy.mimeType);
            setResponseHeader(event, 'Content-Disposition', `${policy.disposition}; filename*=UTF-8''${encodeURIComponent(policy.filename)}`);
            setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
            setResponseHeader(event, 'Cache-Control', 'private, no-store');
            // sendStream resolves before consumption in h3's web adapter. The
            // stream owns the descriptor until EOF, error or cancellation.
            stream = publicationStream(handle, claims.sizeBytes);
            const cancel = () => { if (!stream!.readableEnded) stream!.destroy(createError({ statusCode: 499, statusMessage: 'Download cancelled' })); };
            event.node.res.once('close', cancel);
            event.web?.request?.signal.addEventListener('abort', cancel, { once: true });
            stream.once('close', () => {
                event.node.res.off('close', cancel);
                event.web?.request?.signal.removeEventListener('abort', cancel);
            });
            // Explicit conversion preserves cancellation propagation; allowing
            // Response to implicitly wrap a Node stream can lose that signal.
            return await sendStream(event, event.web
                ? Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength } }) as unknown as ReadableStream<Uint8Array>
                : stream);
        } catch (error) {
            if (stream) stream.destroy();
            else await handle.close();
            throw error;
        }
    });
    async function recover(input: RecoveryInput) {
        const deps = dependencies();
        if (!Number.isSafeInteger(input.retentionSeconds) || input.retentionSeconds < 0 ||
            (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100))) fail(400, 'Invalid recovery bounds');
        const page = await deps.coordinator.listGenerationUploadRecovery({ ...input, limit: input.limit ?? 100 });
        if (page.items.length > (input.limit ?? 100) || (page.hasMore && !page.nextCursor)) fail(502, 'Invalid recovery page');
        const items: RecoveryItem[] = [];
        for (let intent of page.items) {
            const item: RecoveryItem = { intentId: intent.intentId, generationId: intent.generationId, status: 'retained' };
            items.push(item);
            try {
                if (intent.workspaceId !== input.workspaceId) fail(409, 'Recovery workspace mismatch');
                binding(deps, intent, intent);
                if (intent.state === 'reserved' && intent.purpose === 'upload') {
                    const allocation = await deps.store.inspectAllocation(intent);
                    if (allocation.status === 'incomplete') { item.reason = 'pre_ready_unknown'; continue; }
                    intent = (await deps.coordinator.markGenerationUploadReady({ ...key(intent), storageId: allocation.receipt.storageId, readyReceiptId: allocation.receipt.readyReceiptId })).intent;
                }
                const claimKey = { workspaceId: intent.workspaceId, hash: intent.hash, generationId: intent.generationId, intentId: intent.intentId, claimId: intent.claimId ?? randomUUID() };
                const claim = await deps.coordinator.claimAbandonedGenerationUpload({ ...claimKey, retentionSeconds: input.retentionSeconds });
                if (claim.status === 'blocked') { item.reason = claim.reason; continue; }
                const removed = await deps.store.removeAbandoned(intent, claimKey.claimId, deps.coordinator);
                if (removed.status === 'pending') { item.status = 'pending'; item.reason = removed.reason; continue; }
                await deps.coordinator.completeGenerationUploadAbandonment(claimKey);
                item.status = 'abandoned';
            } catch { item.status = 'pending'; item.reason = 'recovery_unverified'; }
        }
        // These are lifecycle observations, deliberately no reclaimed byte count.
        return { items, hasMore: page.hasMore, nextCursor: page.nextCursor };
    }
    return { adapter, upload, download, recover };
}

/**
 * Dormant immutable-generation filesystem primitives. No route, registry or
 * cleanup capability calls this module. Legacy hash paths are never selected.
 *
 * A permanent slot is an allocation tombstone. Only its exclusive creator may
 * initialize payload; retries NEVER repair/recreate payload. Incomplete slot
 * initialization remains retained. Canonical registration/claims are separate
 * trusted-server operations and must be durable and irreversible before unlink.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, opendir, rmdir, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ExternalStorageGenerationCoordinatorV1, ExternalStorageGenerationKey } from '~~/server/storage/gateway/generation-lifecycle';
import { parseFsHash } from './fs-hash';

export interface FsGenerationSpec extends ExternalStorageGenerationKey { sizeBytes: number }
type Checkpoint = 'slot_created' | 'ready_written' | 'before_blob_publish' | 'blob_published'
    | 'entry_unlinked' | 'before_payload_rmdir' | 'payload_removed';
type Hooks = { checkpoint?: (phase: Checkpoint) => Promise<void> };
type Directory = { handle: FileHandle; path: string; identity: BigIntStats };
type Ready = FsGenerationSpec & { version: 1; namespaceId: string; storageId: string; payloadDevice: string; payloadInode: string };
type Removal = { status: 'removed' | 'already_absent' | 'pending'; removedEntries: number; reason?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE = /^[A-Za-z0-9_-]{1,128}$/;
const TEMP = /^\.upload-[0-9a-f-]{36}$/;
const MANIFEST_LIMIT = 4096;

function invalid(message: string): never { throw new Error('Filesystem generation: ' + message); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function sameInode(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }

async function scoped<T>(fn: (handles: FileHandle[]) => Promise<T>): Promise<T> {
    const handles: FileHandle[] = [];
    const errors: unknown[] = [];
    let result: T | undefined;
    try { result = await fn(handles); } catch (error) { errors.push(error); }
    for (const handle of handles.reverse()) {
        try { await handle.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Filesystem generation operation/close failed');
    return result as T;
}

async function directory(path: string, handles: FileHandle[]): Promise<Directory> {
    if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') invalid('safe directory operations unavailable');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    handles.push(handle);
    const identity = await handle.stat({ bigint: true });
    for (const candidate of ['/proc/self/fd/' + handle.fd, '/dev/fd/' + handle.fd]) {
        try {
            const target = await stat(candidate, { bigint: true });
            if (target.isDirectory() && sameInode(identity, target)) return { handle, path: candidate, identity };
        } catch { /* Unsupported descriptor views never fall back to mutable paths. */ }
    }
    return invalid('pinned directory view unavailable');
}

async function readManifest(parent: Directory, name: string): Promise<Record<string, unknown>> {
    return scoped(async handles => {
        const handle = await open(join(parent.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        handles.push(handle);
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(MANIFEST_LIMIT)) invalid('unsafe manifest');
        const buffer = Buffer.alloc(MANIFEST_LIMIT + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MANIFEST_LIMIT) invalid('manifest too large');
        const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('invalid manifest');
        // An independent reader can arrive before the creating process returns.
        // Do not rely on that process eventually fsyncing the manifest.
        await handle.sync();
        return value as Record<string, unknown>;
    });
}

async function writeManifest(parent: Directory, name: string, value: unknown): Promise<void> {
    await scoped(async handles => {
        const handle = await open(join(parent.path, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        handles.push(handle);
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
    });
    await parent.handle.sync();
}

export class FsGenerationStore {
    constructor(private readonly root: string, private readonly namespaceId: string, private readonly hooks: Hooks = {}) {
        if (!isAbsolute(root) || !UUID.test(namespaceId)) invalid('invalid root or namespace');
    }

    private spec(input: FsGenerationSpec): FsGenerationSpec {
        const hash = parseFsHash(input.hash);
        if (!WORKSPACE.test(input.workspaceId) || !UUID.test(input.generationId) || hash?.algorithm !== 'sha256' ||
            !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) invalid('invalid identity');
        return { workspaceId: input.workspaceId, generationId: input.generationId, hash: hash.canonical, sizeBytes: input.sizeBytes };
    }

    storageId(input: FsGenerationSpec): string {
        const spec = this.spec(input);
        return ['fs-generation-v1', this.namespaceId, spec.workspaceId, spec.generationId, spec.hash.slice(7)].join(':');
    }

    /** Explicit namespace provisioning; never performed by publication/removal. */
    async provision(): Promise<void> {
        await scoped(async handles => {
            const root = await directory(this.root, handles);
            let created = false;
            try { await mkdir(join(root.path, 'generations-v1'), { mode: 0o700 }); created = true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            const namespace = await directory(join(root.path, 'generations-v1'), handles);
            if (created) {
                await mkdir(join(namespace.path, 'workspaces'), { mode: 0o700 });
                await writeManifest(namespace, 'namespace.json', { version: 1, namespaceId: this.namespaceId });
            }
            const manifest = await readManifest(namespace, 'namespace.json');
            if (manifest.version !== 1 || manifest.namespaceId !== this.namespaceId) invalid('namespace mismatch');
            await namespace.handle.sync();
            await root.handle.sync();
        });
    }

    private async workspace(spec: FsGenerationSpec, handles: FileHandle[], create = false): Promise<Directory> {
        const root = await directory(this.root, handles);
        const namespace = await directory(join(root.path, 'generations-v1'), handles);
        const manifest = await readManifest(namespace, 'namespace.json');
        if (manifest.version !== 1 || manifest.namespaceId !== this.namespaceId) invalid('namespace mismatch');
        const workspaces = await directory(join(namespace.path, 'workspaces'), handles);
        if (create) {
            try { await mkdir(join(workspaces.path, spec.workspaceId), { mode: 0o700 }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            await workspaces.handle.sync();
        }
        return directory(join(workspaces.path, spec.workspaceId), handles);
    }

    private async ready(slot: Directory, spec: FsGenerationSpec): Promise<Ready> {
        const value = await readManifest(slot, 'ready.json');
        const expected = { ...spec, version: 1, namespaceId: this.namespaceId, storageId: this.storageId(spec) };
        for (const [key, item] of Object.entries(expected)) if (value[key] !== item) invalid('generation identity mismatch');
        if (typeof value.payloadDevice !== 'string' || !/^\d+$/.test(value.payloadDevice) ||
            typeof value.payloadInode !== 'string' || !/^[1-9]\d*$/.test(value.payloadInode)) invalid('invalid payload identity');
        return value as unknown as Ready;
    }

    private async payload(slot: Directory, ready: Ready, handles: FileHandle[]): Promise<Directory> {
        const payload = await directory(join(slot.path, 'payload'), handles);
        if (String(payload.identity.dev) !== ready.payloadDevice || String(payload.identity.ino) !== ready.payloadInode) invalid('payload directory substituted');
        return payload;
    }

    async allocate(input: FsGenerationSpec): Promise<{ status: 'created' | 'ready' | 'incomplete' | 'payload_missing'; storageId: string }> {
        const spec = this.spec(input);
        return scoped(async handles => {
            const workspace = await this.workspace(spec, handles, true);
            let created = false;
            try { await mkdir(join(workspace.path, spec.generationId), { mode: 0o700 }); created = true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            if (created) await this.hooks.checkpoint?.('slot_created');
            const slot = await directory(join(workspace.path, spec.generationId), handles);
            if (created) {
                await mkdir(join(slot.path, 'payload'), { mode: 0o700 });
                const payload = await directory(join(slot.path, 'payload'), handles);
                await payload.handle.sync();
                await writeManifest(slot, 'ready.json', {
                    ...spec, version: 1, namespaceId: this.namespaceId, storageId: this.storageId(spec),
                    payloadDevice: String(payload.identity.dev), payloadInode: String(payload.identity.ino),
                });
                await this.hooks.checkpoint?.('ready_written');
            }
            let ready: Ready;
            try { ready = await this.ready(slot, spec); }
            catch (error) {
                if (!created && isMissing(error)) return { status: 'incomplete', storageId: this.storageId(spec) };
                throw error;
            }
            try { await this.payload(slot, ready, handles); }
            catch (error) {
                if (!created && isMissing(error)) return { status: 'payload_missing', storageId: this.storageId(spec) };
                throw error;
            }
            for (const handle of [...handles].reverse()) await handle.sync();
            return { status: created ? 'created' : 'ready', storageId: this.storageId(spec) };
        });
    }

    private async verifyBlob(payload: Directory, spec: FsGenerationSpec): Promise<void> {
        await scoped(async handles => {
            const handle = await open(join(payload.path, 'blob'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            handles.push(handle);
            const before = await handle.stat({ bigint: true });
            if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(spec.sizeBytes)) invalid('unsafe or mismatched published blob');
            const digest = createHash('sha256');
            let size = 0;
            for await (const chunk of handle.createReadStream({ autoClose: false })) {
                size += chunk.length;
                if (size > spec.sizeBytes) invalid('published blob grew');
                digest.update(chunk);
            }
            const current = await lstat(join(payload.path, 'blob'), { bigint: true });
            if (!current.isFile() || current.nlink !== 1n || !sameInode(before, current) || size !== spec.sizeBytes ||
                'sha256:' + digest.digest('hex') !== spec.hash) invalid('published blob verification failed');
            await handle.sync();
        });
    }

    /** Returns a trusted-server receipt, not a client-supplied proof. Callers
     * must still register it under the canonical transaction; a stale receipt
     * never releases a claimed/deleted generation.
     */
    async publish(input: FsGenerationSpec, source: AsyncIterable<Uint8Array>): Promise<FsGenerationSpec & { storageId: string; status: 'published' | 'replayed' }> {
        const spec = this.spec(input);
        return scoped(async handles => {
            const workspace = await this.workspace(spec, handles);
            const slot = await directory(join(workspace.path, spec.generationId), handles);
            const payload = await this.payload(slot, await this.ready(slot, spec), handles);
            const temporary = join(payload.path, '.upload-' + randomUUID());
            let failure: unknown;
            let status: 'published' | 'replayed' = 'published';
            try {
                await scoped(async files => {
                    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                    files.push(handle);
                    const digest = createHash('sha256');
                    let size = 0;
                    for await (const chunk of source) {
                        size += chunk.byteLength;
                        if (!Number.isSafeInteger(size) || size > spec.sizeBytes) invalid('upload size mismatch');
                        digest.update(chunk);
                        await handle.writeFile(chunk);
                    }
                    if (size !== spec.sizeBytes || 'sha256:' + digest.digest('hex') !== spec.hash) invalid('upload hash or size mismatch');
                    await handle.sync();
                });
                await this.hooks.checkpoint?.('before_blob_publish');
                try { await link(temporary, join(payload.path, 'blob')); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                    status = 'replayed';
                }
                await this.hooks.checkpoint?.('blob_published');
            } catch (error) { failure = error; }
            try { await unlink(temporary); }
            catch (error) {
                if (!isMissing(error)) failure = failure ? new AggregateError([failure, error], 'Publication and temporary cleanup failed') : error;
            }
            if (failure) throw failure;
            await this.verifyBlob(payload, spec);
            // Persist every namespace edge independently of allocation's caller.
            // A creator may still be paused before syncing its parent directory.
            for (const handle of [...handles].reverse()) await handle.sync();
            const namedPayload = await lstat(join(slot.path, 'payload'), { bigint: true });
            if (!namedPayload.isDirectory() || !sameInode(namedPayload, payload.identity)) invalid('payload directory substituted');
            return { ...spec, storageId: this.storageId(spec), status };
        });
    }

    /** Bounded exact-generation removal. Never calls completeDeletion itself.
     * Permanent slots are retained, so permitted allocation/publication retries
     * cannot recreate a removed payload directory. Open unlinked files may still
     * occupy disk blocks: removedEntries is not a reclaimed-byte estimate.
     */
    async remove(input: FsGenerationSpec, claimId: string,
        coordinator: Pick<ExternalStorageGenerationCoordinatorV1, 'version' | 'storageProviderId' | 'getGeneration'>,
        maxEntries = 1024): Promise<Removal> {
        const spec = this.spec(input);
        if (!claimId || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) invalid('invalid removal request');
        if (coordinator?.version !== 1 || coordinator.storageProviderId !== 'fs') invalid('coordinator provider mismatch');
        const record = await coordinator.getGeneration(spec);
        const recordHash = record && parseFsHash(record.hash);
        if (!record || (record.state !== 'claimed' && record.state !== 'deleted') || record.claimId !== claimId ||
            record.workspaceId !== spec.workspaceId || record.generationId !== spec.generationId ||
            recordHash?.algorithm !== 'sha256' || recordHash.canonical !== spec.hash ||
            record.sizeBytes !== spec.sizeBytes || record.storageId !== this.storageId(spec)) invalid('durable claim mismatch');
        return scoped(async handles => {
            const workspace = await this.workspace(spec, handles);
            const slot = await directory(join(workspace.path, spec.generationId), handles);
            const ready = await this.ready(slot, spec);
            let payload: Directory;
            try { payload = await this.payload(slot, ready, handles); }
            catch (error) {
                if (!isMissing(error)) throw error;
                await slot.handle.sync();
                return { status: 'already_absent', removedEntries: 0 };
            }
            let removedEntries = 0;
            try {
                const entries: Array<{ name: string; inode: string; links: bigint }> = [];
                const counts = new Map<string, bigint>();
                for await (const entry of await opendir(payload.path)) {
                    if (entries.length >= maxEntries) return { status: 'pending', removedEntries, reason: 'entry_limit' };
                    if (!entry.isFile() || (entry.name !== 'blob' && !TEMP.test(entry.name))) return { status: 'pending', removedEntries, reason: 'unsafe_entry' };
                    const info = await lstat(join(payload.path, entry.name), { bigint: true });
                    if (!info.isFile()) return { status: 'pending', removedEntries, reason: 'unsafe_entry' };
                    const inode = info.dev + ':' + info.ino;
                    entries.push({ name: entry.name, inode, links: info.nlink });
                    counts.set(inode, (counts.get(inode) ?? 0n) + 1n);
                }
                if (entries.some(entry => entry.links !== counts.get(entry.inode))) return { status: 'pending', removedEntries, reason: 'external_hardlink' };
                for (const entry of entries) {
                    try { await unlink(join(payload.path, entry.name)); removedEntries++; }
                    catch (error) { if (!isMissing(error)) throw error; }
                    await this.hooks.checkpoint?.('entry_unlinked');
                }
                await this.hooks.checkpoint?.('before_payload_rmdir');
                // This check and rmdir are separate syscalls. Permitted writers
                // never rename/recreate payload; hostile same-UID mutation is
                // outside the exclusively managed namespace contract.
                try {
                    const namedPayload = await lstat(join(slot.path, 'payload'), { bigint: true });
                    if (!namedPayload.isDirectory() || !sameInode(namedPayload, payload.identity)) {
                        return { status: 'pending', removedEntries, reason: 'payload_path_changed' };
                    }
                } catch (error) {
                    if (!isMissing(error) || (await payload.handle.stat({ bigint: true })).nlink !== 0n) throw error;
                }
                try { await rmdir(join(slot.path, 'payload')); }
                catch (error) { if (!isMissing(error)) throw error; }
                if ((await payload.handle.stat({ bigint: true })).nlink !== 0n) return { status: 'pending', removedEntries, reason: 'payload_path_changed' };
                await this.hooks.checkpoint?.('payload_removed');
                await slot.handle.sync();
                return { status: 'removed', removedEntries };
            } catch {
                return { status: 'pending', removedEntries, reason: 'filesystem_operation_incomplete' };
            }
        });
    }
}

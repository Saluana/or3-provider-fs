/** Test-only coordinator composition: no HTTP routes, registry, flags or GC job. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _resetForTest, destroySqliteDb, getRawDb, initializeSqliteDb, type SqliteRawDatabase } from '../../sqlite/src/runtime/server/db/kysely';
import { runMigrations } from '../../sqlite/src/runtime/server/db/migrate';
import { generationGuardTriggers } from '../../sqlite/src/runtime/server/db/storage-generation-guards';
import { SqliteExternalStorageGenerationCoordinator } from '../../sqlite/src/runtime/server/storage/sqlite-generation-coordinator';
import { FsGenerationStore, type FsGenerationSpec } from '../src/runtime/server/storage/fs-generations';

const data = Buffer.from('immutable verified bytes');
const hash = createHash('sha256').update(data).digest('hex');
const bytes = async function* () { yield data; };
let temporary: string;
let root: string;
let filename: string;
let namespaceId: string;
let spec: FsGenerationSpec;
let store: FsGenerationStore;
let raw: SqliteRawDatabase;
let coordinator: SqliteExternalStorageGenerationCoordinator;
const children: ChildProcessWithoutNullStreams[] = [];
const slot = (target = spec) => join(root, 'generations-v1', 'workspaces', target.workspaceId, target.generationId);

function actor(mode: 'publish' | 'remove', pause: string) {
    const child = spawn('bun', [fileURLToPath(new URL('./sqlite-generation-worker.ts', import.meta.url)),
        mode, root, namespaceId, filename, JSON.stringify(spec), pause], { stdio: 'pipe' });
    children.push(child);
    const input = createInterface({ input: child.stdout });
    const lines = input[Symbol.asyncIterator]();
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
    });
    return {
        async next(): Promise<Record<string, unknown>> {
            while (true) {
                const line = await lines.next();
                if (line.done) break;
                if (line.value.startsWith('{')) return JSON.parse(line.value) as Record<string, unknown>;
            }
            throw new Error('Actor exited without result: ' + stderr);
        },
        resume: () => { child.stdin.write('resume\n'); },
        async kill() { child.kill('SIGKILL'); await exited; },
        exited,
    };
}

async function register(target = spec) {
    await store.allocate(target);
    return coordinator.registerVerifiedGeneration(await store.publish(target, bytes()));
}
async function collect(target = spec) {
    const claim = await coordinator.claimGeneration({ ...target, claimId: 'claim-one', retentionSeconds: 0 });
    if (claim.status === 'blocked') return claim;
    const removed = await store.remove(target, 'claim-one', coordinator);
    if (removed.status !== 'pending') await coordinator.completeDeletion({ ...target, claimId: 'claim-one' });
    return removed;
}
function reference(id: string, deleted = 0) {
    raw.prepare('INSERT INTO s_messages (workspace_id,id,data_json,deleted) VALUES (?,?,?,?)')
        .run(spec.workspaceId, id, JSON.stringify({ file_hashes: [hash] }), deleted);
}
function metadata(deleted = 0) {
    raw.prepare('INSERT INTO s_file_meta (workspace_id,id,data_json,deleted) VALUES (?,?,?,?)')
        .run(spec.workspaceId, hash, JSON.stringify({ hash, storage_id: store.storageId(spec), size_bytes: data.length }), deleted);
}

beforeEach(async () => {
    _resetForTest();
    temporary = await mkdtemp(join(tmpdir(), 'or3-fs-sqlite-'));
    root = join(temporary, 'objects');
    filename = join(temporary, 'canonical.sqlite');
    await mkdir(root);
    namespaceId = randomUUID();
    spec = { workspaceId: 'workspace', generationId: randomUUID(), hash: 'sha256:' + hash, sizeBytes: data.length };
    store = new FsGenerationStore(root, namespaceId);
    await store.provision();
    const db = await initializeSqliteDb({ path: filename, driver: 'bun', journalMode: 'WAL', synchronous: 'FULL' });
    await runMigrations(db);
    raw = getRawDb();
    coordinator = new SqliteExternalStorageGenerationCoordinator({ storageProviderId: 'fs' });
});
afterEach(async () => {
    for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve));
            child.kill('SIGKILL');
            await exited;
        }
    }
    await destroySqliteDb();
    await rm(temporary, { recursive: true, force: true });
});

describe('dormant real SQLite claims with immutable filesystem generations', () => {
    it('refuses unregistered deletion; publishes, registers and conditionally removes exact verified bytes', async () => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        await expect(store.remove(spec, 'claim-one', coordinator)).rejects.toThrow(/claim/);
        expect(await collect()).toEqual({ status: 'blocked', reason: 'missing' });
        const registration = await register();
        expect(registration.generation.hash).toBe(hash); // Real normalization boundary.
        expect((await collect()).status).toBe('removed');
        expect((await coordinator.getGeneration(spec))?.state).toBe('deleted');
        expect(await readdir(slot())).toEqual(['ready.json']);
        expect((await collect()).status).toBe('already_absent');
        expect((await store.allocate(spec)).status).toBe('payload_missing');
        await expect(store.publish(spec, bytes())).rejects.toThrow();
    });

    it('keeps referenced bytes then refuses restoration and new references once claimed', async () => {
        await register();
        reference('message');
        metadata();
        expect(await collect()).toEqual({ status: 'blocked', reason: 'in_use' });
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
        raw.exec('UPDATE s_messages SET deleted = 1; UPDATE s_file_meta SET deleted = 1');
        const remover = actor('remove', 'claim_committed');
        expect(await remover.next()).toMatchObject({ event: 'paused' });
        expect(() => reference('new-reference')).toThrow();
        expect(() => raw.exec('UPDATE s_messages SET deleted = 0')).toThrow();
        expect(() => raw.exec('UPDATE s_file_meta SET deleted = 0')).toThrow();
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
        remover.resume();
        expect(await remover.next()).toMatchObject({ event: 'result', result: { status: 'removed' } });
        expect(await remover.exited).toBe(0);
        expect((await coordinator.getGeneration(spec))?.state).toBe('deleted');
    });

    it('does not let a delayed publisher resurrect bytes or canonical identity after deletion', async () => {
        await register();
        const uploader = actor('publish', 'before_blob_publish');
        expect(await uploader.next()).toMatchObject({ event: 'paused' });
        expect((await collect()).status).toBe('removed');
        uploader.resume();
        expect(await uploader.next()).toMatchObject({ event: 'error' });
        expect(await uploader.exited).toBe(1);
        expect((await coordinator.getGeneration(spec))?.state).toBe('deleted');
        expect(await readdir(slot())).toEqual(['ready.json']);
    });

    it('keeps the claim pending when a real publisher adds a temporary file before rmdir', async () => {
        await register();
        const remover = actor('remove', 'before_payload_rmdir');
        expect(await remover.next()).toMatchObject({ event: 'paused' });
        const uploader = actor('publish', 'before_blob_publish');
        expect(await uploader.next()).toMatchObject({ event: 'paused' });
        remover.resume();
        expect(await remover.next()).toMatchObject({ event: 'result', result: { status: 'pending' } });
        expect(await remover.exited).toBe(0);
        expect((await coordinator.getGeneration(spec))?.state).toBe('claimed');
        uploader.resume();
        expect(await uploader.next()).toMatchObject({ event: 'error', message: expect.stringContaining('irreversible') });
        expect(await uploader.exited).toBe(1);
        expect((await coordinator.getGeneration(spec))?.state).toBe('claimed');
        expect((await collect()).status).toBe('removed');
        expect((await coordinator.getGeneration(spec))?.state).toBe('deleted');
    });

    it('retains a claimed old head during successor publication and keeps successor bytes safe from the old worker', async () => {
        await register();
        const remover = actor('remove', 'claim_committed');
        expect(await remover.next()).toMatchObject({ event: 'paused' });
        const successor = { ...spec, generationId: randomUUID() };
        await store.allocate(successor);
        const receipt = await store.publish(successor, bytes());
        expect(() => reference('before-registration')).toThrow();
        await coordinator.registerVerifiedGeneration(receipt);
        reference('successor-reference');
        const path = join(slot(successor), 'payload', 'blob');
        const before = await stat(path);
        remover.resume();
        expect(await remover.next()).toMatchObject({ event: 'result', result: { status: 'removed' } });
        expect(await remover.exited).toBe(0);
        expect((await coordinator.getGeneration(spec))?.state).toBe('deleted');
        expect((await coordinator.getGeneration(successor))?.state).toBe('verified');
        expect((await collect()).status).toBe('already_absent');
        expect((await stat(path)).ino).toBe(before.ino);
        expect(await readFile(path)).toEqual(data);
    });

    it.each(['claim_committed', 'entry_unlinked', 'payload_removed'])('replays durably after collector SIGKILL at %s', async phase => {
        await register();
        const remover = actor('remove', phase);
        expect(await remover.next()).toMatchObject({ event: 'paused' });
        expect((await coordinator.getGeneration(spec))?.state).toBe('claimed');
        await remover.kill();
        await destroySqliteDb();
        await initializeSqliteDb({ path: filename, driver: 'bun', journalMode: 'WAL', synchronous: 'FULL' });
        raw = getRawDb();
        coordinator = new SqliteExternalStorageGenerationCoordinator({ storageProviderId: 'fs' });
        expect((await coordinator.getGeneration(spec))?.state).toBe('claimed');
        expect((await collect()).status).toBe(phase === 'payload_removed' ? 'already_absent' : 'removed');
        expect((await coordinator.getGeneration(spec))?.state).toBe('deleted');
        expect((await store.allocate(spec)).status).toBe('payload_missing');
    });

    it('reconciles two real collectors replaying the same claim while preserving the successor', async () => {
        await register();
        const first = actor('remove', 'before_payload_rmdir');
        expect(await first.next()).toMatchObject({ event: 'paused' });
        const second = actor('remove', 'never');
        expect(await second.next()).toMatchObject({ event: 'result', result: { status: 'removed' } });
        expect(await second.exited).toBe(0);
        const successor = { ...spec, generationId: randomUUID() };
        await register(successor);
        const path = join(slot(successor), 'payload', 'blob');
        const before = await stat(path);
        first.resume();
        expect(await first.next()).toMatchObject({ event: 'result', result: { status: 'removed' } });
        expect(await first.exited).toBe(0);
        expect((await coordinator.getGeneration(spec))?.state).toBe('deleted');
        expect(await readdir(slot())).toEqual(['ready.json']);
        expect((await stat(path)).ino).toBe(before.ino);
        expect(await readFile(path)).toEqual(data);
    });

    it('leaves bytes untouched when the real authorization read has unsafe durability, an outer transaction or missing guard', async () => {
        await register();
        await coordinator.claimGeneration({ ...spec, claimId: 'claim-one', retentionSeconds: 0 });
        raw.exec('PRAGMA synchronous = NORMAL');
        await expect(store.remove(spec, 'claim-one', coordinator)).rejects.toThrow(/FULL/);
        raw.exec('PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
        await expect(store.remove(spec, 'claim-one', coordinator)).rejects.toThrow(/outer transaction/);
        raw.exec('ROLLBACK');
        const name = Object.keys(generationGuardTriggers())[0]!;
        raw.exec(`DROP TRIGGER ${name}`);
        await expect(store.remove(spec, 'claim-one', coordinator)).rejects.toThrow(/integrity/);
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
    });

    it('refuses a real coordinator bound to a foreign storage provider before unlink', async () => {
        await store.allocate(spec);
        const receipt = await store.publish(spec, bytes());
        const foreign = new SqliteExternalStorageGenerationCoordinator({ storageProviderId: 's3' });
        await foreign.registerVerifiedGeneration(receipt);
        await foreign.claimGeneration({ ...spec, claimId: 'claim-one', retentionSeconds: 0 });
        await expect(store.remove(spec, 'claim-one', foreign)).rejects.toThrow(/provider/);
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
    });
});

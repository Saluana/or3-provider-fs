/** Failure modes: namespace recreation by delayed allocators, publication
 * overwrite, unverified bytes, mutable-path deletion, false crash completion,
 * and stale workers touching successor generations. These tests use real files.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExternalStorageGenerationRecord } from '~~/server/storage/gateway/generation-lifecycle';
import { FsGenerationStore, type FsGenerationSpec } from '../server/storage/fs-generations';

const data = Buffer.from('immutable verified bytes');
const hash = 'sha256:' + createHash('sha256').update(data).digest('hex');
let root: string;
let namespaceId: string;
let spec: FsGenerationSpec;
let store: FsGenerationStore;
const children: ChildProcessWithoutNullStreams[] = [];
const bytes = async function* (value = data) { yield value; };
const slot = () => join(root, 'generations-v1', 'workspaces', spec.workspaceId, spec.generationId);

function claimed(target = spec, claimId = 'claim-one') {
    const generation: ExternalStorageGenerationRecord = {
        ...target, storageId: store.storageId(target), state: 'claimed', claimId,
        createdAt: 1, lastActivityAt: 1, claimedAt: 2,
    };
    return { version: 1 as const, storageProviderId: 'fs', getGeneration: async () => generation };
}

function actor(mode: 'allocate' | 'publish' | 'remove', pause: string) {
    const child = spawn('bun', [fileURLToPath(new URL('../../../test/fixtures/fs-generation-worker.ts', import.meta.url)),
        mode, root, namespaceId, JSON.stringify(spec), pause], { stdio: 'pipe' });
    children.push(child);
    const events: Array<Record<string, unknown>> = [];
    const waiters: Array<(event: Record<string, unknown>) => void> = [];
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdout.on('data', chunk => {
        buffer += String(chunk);
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
            const event = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
            buffer = buffer.slice(end + 1);
            const waiting = waiters.shift();
            if (waiting) waiting(event); else events.push(event);
        }
    });
    const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
    });
    return {
        async next() {
            const event = events.shift();
            if (event) return event;
            return Promise.race([
                new Promise<Record<string, unknown>>(resolve => { waiters.push(resolve); }),
                exited.then(() => { throw new Error('Worker exited before event: ' + stderr); }),
            ]);
        },
        resume: () => { child.stdin.write('resume\n'); },
        async kill() { child.kill('SIGKILL'); await exited; },
        exited,
    };
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'or3-generation-'));
    namespaceId = randomUUID();
    spec = { workspaceId: 'workspace', generationId: randomUUID(), hash, sizeBytes: data.length };
    store = new FsGenerationStore(root, namespaceId);
    await store.provision();
});
afterEach(async () => {
    for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve));
            child.kill('SIGKILL');
            await exited;
        }
    }
    await rm(root, { recursive: true, force: true });
});

describe('dormant immutable filesystem generations', () => {
    it('inspects readiness without creating missing slots and preserves its durable receipt across reopen', async () => {
        expect(await store.inspectAllocation(spec)).toMatchObject({ status: 'incomplete' });
        expect(await readdir(join(root, 'generations-v1', 'workspaces'))).toEqual([]);
        await store.allocate(spec);
        const ready = await store.inspectAllocation(spec);
        expect(ready.status).toBe('ready');
        if (ready.status !== 'ready') throw new Error('Missing ready receipt');
        expect(ready.receipt.readyReceiptId).toMatch(/^[a-f0-9-]{36}$/);
        expect(ready.receipt).toMatchObject({ ...spec, namespaceId, storageId: store.storageId(spec) });
        expect(await new FsGenerationStore(root, namespaceId).inspectAllocation(spec)).toEqual(ready);
        await store.publish(spec, bytes());
        expect(await store.verifyPublication(spec)).toEqual(ready.receipt);
        await store.remove(spec, 'claim-one', claimed());
        expect(await store.inspectAllocation(spec)).toEqual({ status: 'payload_missing', receipt: ready.receipt });
        await expect(store.verifyPublication(spec)).rejects.toThrow();
    });

    it('never adopts an old manifest without a durable upload-readiness receipt', async () => {
        await store.allocate(spec);
        const manifestPath = join(slot(), 'ready.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
        delete manifest.readyReceiptId;
        await writeFile(manifestPath, JSON.stringify(manifest));
        await store.publish(spec, bytes()); // Existing primitive behavior remains intact.
        await expect(store.inspectAllocation(spec)).rejects.toThrow(/receipt/);
        await expect(store.verifyPublication(spec)).rejects.toThrow(/receipt/);
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
    });

    it('independently verifies published bytes rather than trusting a client receipt or file existence', async () => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        await writeFile(join(slot(), 'payload', 'blob'), Buffer.alloc(data.length, 0));
        await expect(store.verifyPublication(spec)).rejects.toThrow(/verification/);
    });

    it('requires a distinct durable upload-abandonment claim bound to the persisted readiness receipt', async () => {
        await store.allocate(spec);
        const inspection = await store.inspectAllocation(spec);
        if (inspection.status !== 'ready') throw new Error('Not ready');
        const intentId = randomUUID();
        const intent = { ...spec, intentId, userId: 'owner', storageProviderId: 'fs', namespaceId,
            storageId: store.storageId(spec), sizeBytes: spec.sizeBytes, reservedBytes: spec.sizeBytes,
            mimeType: 'text/plain', purpose: 'upload' as const, createdAt: 1, expiresAt: 2, state: 'abandon_claimed' as const,
            readyReceiptId: inspection.receipt.readyReceiptId, claimId: 'abandon-one', claimedAt: 3 };
        const coordinator = { version: 1 as const, uploadVersion: 1 as const, storageProviderId: 'fs',
            getGenerationUploadClaim: async () => intent };
        await store.publish(spec, bytes());
        for (const changed of [{ namespaceId: randomUUID() }, { readyReceiptId: randomUUID() }, { claimId: 'other' },
            { state: 'ready' as const }, { intentId: randomUUID() }]) {
            await expect(store.removeAbandoned({ ...spec, intentId }, 'abandon-one', {
                ...coordinator, getGenerationUploadClaim: async () => ({ ...intent, ...changed }),
            })).rejects.toThrow();
        }
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
        expect((await store.removeAbandoned({ ...spec, intentId }, 'abandon-one', coordinator)).status).toBe('removed');
        expect((await store.removeAbandoned({ ...spec, intentId }, 'abandon-one', coordinator)).status).toBe('already_absent');
        expect((await store.allocate(spec)).status).toBe('payload_missing');
    });

    it('initializes once, publishes verified bytes without overwrite and preserves the permanent slot', async () => {
        expect((await store.allocate(spec)).status).toBe('created');
        expect((await store.allocate(spec)).status).toBe('ready');
        const publication = await store.publish(spec, bytes());
        expect(publication).toMatchObject({ status: 'published', hash, sizeBytes: data.length, storageId: store.storageId(spec) });
        const before = await stat(join(slot(), 'payload', 'blob'));
        expect((await store.publish(spec, bytes())).status).toBe('replayed');
        const after = await stat(join(slot(), 'payload', 'blob'));
        expect(after.ino).toBe(before.ino);
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
        expect((await store.remove(spec, 'claim-one', claimed())).status).toBe('removed');
        expect(await readdir(slot())).toEqual(['ready.json']);
        expect((await store.allocate(spec)).status).toBe('payload_missing');
        await expect(store.publish(spec, bytes())).rejects.toThrow();
        expect((await store.remove(spec, 'claim-one', claimed())).status).toBe('already_absent');
    });

    it('refuses to finish an incomplete allocation from another creator', async () => {
        const interrupted = new FsGenerationStore(root, namespaceId, { checkpoint: async phase => {
            if (phase === 'slot_created') throw new Error('interrupted initializer');
        } });
        await expect(interrupted.allocate(spec)).rejects.toThrow('interrupted initializer');
        expect((await store.allocate(spec)).status).toBe('incomplete');
        expect(await readdir(slot())).toEqual([]);
        await expect(store.publish(spec, bytes())).rejects.toThrow();
        await expect(store.remove(spec, 'claim-one', claimed())).rejects.toThrow();
    });

    it.each([
        ['wrong hash', Buffer.from('wrong bytes same length!')],
        ['short body', data.subarray(0, -1)],
        ['long body', Buffer.concat([data, Buffer.from('!')])],
    ])('does not publish a %s', async (_label, body) => {
        await store.allocate(spec);
        await expect(store.publish(spec, bytes(body))).rejects.toThrow();
        expect(await readdir(join(slot(), 'payload'))).toEqual([]);
    });

    it('publishes a valid zero-byte generation', async () => {
        spec = { ...spec, hash: 'sha256:' + createHash('sha256').update('').digest('hex'), sizeBytes: 0 };
        await store.allocate(spec);
        expect((await store.publish(spec, bytes(Buffer.alloc(0)))).status).toBe('published');
        expect((await stat(join(slot(), 'payload', 'blob'))).size).toBe(0);
    });

    it('rejects legacy hashes, path components, namespace mismatches and reused allocation identities', async () => {
        await expect(store.allocate({ ...spec, hash: 'md5:' + 'a'.repeat(32) })).rejects.toThrow();
        await expect(store.allocate({ ...spec, workspaceId: '../neighbor' })).rejects.toThrow();
        await store.allocate(spec);
        await expect(store.allocate({ ...spec, sizeBytes: 1 })).rejects.toThrow();
        await expect(new FsGenerationStore(root, randomUUID()).provision()).rejects.toThrow();
    });

    it('never removes a live, mismatched, or foreign claim target', async () => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        const record = await claimed().getGeneration();
        for (const changed of [{ state: 'verified' as const }, { claimId: 'foreign' }, { storageId: 'workspace:' + hash }, { generationId: randomUUID() }]) {
            await expect(store.remove(spec, 'claim-one', { ...claimed(), getGeneration: async () => ({ ...record, ...changed }) })).rejects.toThrow();
        }
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
    });

    it.each([undefined, '', 'filesystem', 's3'])('refuses missing or foreign coordinator provider %s', async storageProviderId => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        const invalid = { ...claimed(), storageProviderId } as Parameters<FsGenerationStore['remove']>[2];
        await expect(store.remove(spec, 'claim-one', invalid)).rejects.toThrow(/provider/);
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
    });

    it('reports pending when a delayed publisher adds an entry before rmdir, then safely retries', async () => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        let delayed = false;
        const racing = new FsGenerationStore(root, namespaceId, { checkpoint: async phase => {
            if (phase === 'before_payload_rmdir' && !delayed) {
                delayed = true;
                await writeFile(join(slot(), 'payload', '.upload-' + randomUUID()), 'late');
            }
        } });
        expect((await racing.remove(spec, 'claim-one', claimed())).status).toBe('pending');
        expect((await store.remove(spec, 'claim-one', claimed())).status).toBe('removed');
    });

    it('recovers after interruption between unlink and rmdir without deleting the slot', async () => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        const interrupted = new FsGenerationStore(root, namespaceId, { checkpoint: async phase => {
            if (phase === 'entry_unlinked') throw new Error('interrupted removal');
        } });
        expect((await interrupted.remove(spec, 'claim-one', claimed())).status).toBe('pending');
        expect(await readdir(slot())).toContain('ready.json');
        expect((await store.remove(spec, 'claim-one', claimed())).status).toBe('removed');
    });

    it('cannot target a successor sharing the same hash', async () => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        const successor = { ...spec, generationId: randomUUID() };
        await store.allocate(successor);
        await store.publish(successor, bytes());
        const path = join(root, 'generations-v1', 'workspaces', spec.workspaceId, successor.generationId, 'payload', 'blob');
        const before = await stat(path);
        await store.remove(spec, 'claim-one', claimed());
        await store.remove(spec, 'claim-one', claimed());
        expect((await stat(path)).ino).toBe(before.ino);
        expect(await readFile(path)).toEqual(data);
    });

    it('refuses payload directory substitution and does not follow blob symlinks', async () => {
        await store.allocate(spec);
        await rename(join(slot(), 'payload'), join(slot(), 'original-payload'));
        await mkdir(join(slot(), 'payload'));
        await writeFile(join(slot(), 'payload', 'blob'), 'substituted');
        await expect(store.publish(spec, bytes())).rejects.toThrow();
        await expect(store.remove(spec, 'claim-one', claimed())).rejects.toThrow();
        expect(await readFile(join(slot(), 'payload', 'blob'), 'utf8')).toBe('substituted');
        await rm(join(slot(), 'payload'), { recursive: true });
        await rename(join(slot(), 'original-payload'), join(slot(), 'payload'));
        const outside = join(root, 'protected');
        await writeFile(outside, 'protected');
        await symlink(outside, join(slot(), 'payload', 'blob'));
        await expect(store.publish(spec, bytes())).rejects.toThrow();
        expect((await store.remove(spec, 'claim-one', claimed())).status).toBe('pending');
        expect(await readFile(outside, 'utf8')).toBe('protected');
    });

    it('refuses external hardlinks and bounded incomplete enumeration without acknowledging removal', async () => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        const outside = join(root, 'external-link');
        await link(join(slot(), 'payload', 'blob'), outside);
        expect(await store.remove(spec, 'claim-one', claimed())).toMatchObject({ status: 'pending', reason: 'external_hardlink', removedEntries: 0 });
        expect(await readFile(outside)).toEqual(data);
        await unlink(outside);
        await writeFile(join(slot(), 'payload', '.upload-' + randomUUID()), 'incomplete');
        expect(await store.remove(spec, 'claim-one', claimed(), 1)).toMatchObject({ status: 'pending', reason: 'entry_limit', removedEntries: 0 });
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
        expect((await store.remove(spec, 'claim-one', claimed())).status).toBe('removed');
    });

    it('never follows workspace or permanent slot symlinks', async () => {
        await store.allocate(spec);
        const workspace = join(root, 'generations-v1', 'workspaces', spec.workspaceId);
        await rename(workspace, workspace + '-original');
        await symlink(workspace + '-original', workspace);
        await expect(store.publish(spec, bytes())).rejects.toThrow();
        await expect(store.allocate(spec)).rejects.toThrow();
        await expect(store.remove(spec, 'claim-one', claimed())).rejects.toThrow();
        await unlink(workspace);
        await rename(workspace + '-original', workspace);
        await rename(slot(), slot() + '-original');
        await symlink(slot() + '-original', slot());
        await expect(store.publish(spec, bytes())).rejects.toThrow();
        await expect(store.allocate(spec)).rejects.toThrow();
        await expect(store.remove(spec, 'claim-one', claimed())).rejects.toThrow();
    });

    it('does not let a second process finish a paused or crashed initial allocation', async () => {
        const creator = actor('allocate', 'slot_created');
        expect(await creator.next()).toMatchObject({ event: 'paused' });
        expect((await store.allocate(spec)).status).toBe('incomplete');
        expect(await readdir(slot())).toEqual([]);
        await creator.kill();
        expect((await store.allocate(spec)).status).toBe('incomplete');
        await expect(store.publish(spec, bytes())).rejects.toThrow();
    });

    it('blocks allocation retry after the initial process returns and the payload is retired', async () => {
        const creator = actor('allocate', 'slot_created');
        expect(await creator.next()).toMatchObject({ event: 'paused' });
        expect((await store.allocate(spec)).status).toBe('incomplete');
        creator.resume();
        expect(await creator.next()).toMatchObject({ event: 'result', result: { status: 'created' } });
        expect(await creator.exited).toBe(0);
        await store.publish(spec, bytes());
        await store.remove(spec, 'claim-one', claimed());
        const retry = actor('allocate', 'never');
        expect(await retry.next()).toMatchObject({ event: 'result', result: { status: 'payload_missing' } });
        expect(await retry.exited).toBe(0);
        expect(await readdir(slot())).toEqual(['ready.json']);
    });

    it('independently persists publication before a paused allocator returns', async () => {
        const creator = actor('allocate', 'ready_written');
        expect(await creator.next()).toMatchObject({ event: 'paused' });
        expect((await store.publish(spec, bytes())).status).toBe('published');
        await creator.kill();
        expect((await store.allocate(spec)).status).toBe('ready');
        expect(await readFile(join(slot(), 'payload', 'blob'))).toEqual(data);
        expect((await store.remove(spec, 'claim-one', claimed())).status).toBe('removed');
    });

    it('cannot publish from an open directory descriptor after another process removes the payload', async () => {
        await store.allocate(spec);
        const uploader = actor('publish', 'before_blob_publish');
        expect(await uploader.next()).toMatchObject({ event: 'paused' });
        expect((await store.remove(spec, 'claim-one', claimed())).status).toBe('removed');
        uploader.resume();
        expect(await uploader.next()).toMatchObject({ event: 'error' });
        expect(await uploader.exited).toBe(1);
        expect(await readdir(slot())).toEqual(['ready.json']);
    });

    it('never overwrites the winner when duplicate publisher processes race', async () => {
        await store.allocate(spec);
        const uploader = actor('publish', 'before_blob_publish');
        expect(await uploader.next()).toMatchObject({ event: 'paused' });
        await store.publish(spec, bytes());
        const before = await stat(join(slot(), 'payload', 'blob'));
        uploader.resume();
        expect(await uploader.next()).toMatchObject({ event: 'result', result: { status: 'replayed' } });
        expect(await uploader.exited).toBe(0);
        expect((await stat(join(slot(), 'payload', 'blob'))).ino).toBe(before.ino);
    });

    it('recovers a killed publisher after link but before temporary alias unlink', async () => {
        await store.allocate(spec);
        const uploader = actor('publish', 'blob_published');
        expect(await uploader.next()).toMatchObject({ event: 'paused' });
        expect((await stat(join(slot(), 'payload', 'blob'))).nlink).toBe(2);
        await uploader.kill();
        expect((await store.remove(spec, 'claim-one', claimed())).status).toBe('removed');
        expect(await readdir(slot())).toEqual(['ready.json']);
    });

    it.each(['entry_unlinked', 'payload_removed'])('retries after the remover process dies at %s', async phase => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        const remover = actor('remove', phase);
        expect(await remover.next()).toMatchObject({ event: 'paused' });
        await remover.kill();
        const result = await store.remove(spec, 'claim-one', claimed());
        expect(result.status).toBe(phase === 'entry_unlinked' ? 'removed' : 'already_absent');
        expect(await readdir(slot())).toEqual(['ready.json']);
    });

    it('keeps a successor intact while a paused old remover resumes', async () => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        const remover = actor('remove', 'before_payload_rmdir');
        expect(await remover.next()).toMatchObject({ event: 'paused' });
        const successor = { ...spec, generationId: randomUUID() };
        await store.allocate(successor);
        await store.publish(successor, bytes());
        const path = join(root, 'generations-v1', 'workspaces', spec.workspaceId, successor.generationId, 'payload', 'blob');
        const before = await stat(path);
        remover.resume();
        expect(await remover.next()).toMatchObject({ event: 'result', result: { status: 'removed' } });
        expect(await remover.exited).toBe(0);
        expect((await stat(path)).ino).toBe(before.ino);
        expect(await readFile(path)).toEqual(data);
    });

    it('refuses a publication receipt if its payload path is substituted while the publisher pauses', async () => {
        await store.allocate(spec);
        const uploader = actor('publish', 'before_blob_publish');
        expect(await uploader.next()).toMatchObject({ event: 'paused' });
        await rename(join(slot(), 'payload'), join(slot(), 'displaced'));
        await mkdir(join(slot(), 'payload'));
        await writeFile(join(slot(), 'payload', 'blob'), 'protected replacement');
        uploader.resume();
        expect(await uploader.next()).toMatchObject({ event: 'error' });
        expect(await uploader.exited).toBe(1);
        expect(await readFile(join(slot(), 'payload', 'blob'), 'utf8')).toBe('protected replacement');
    });

    it('leaves a substituted empty payload directory untouched when the remover resumes', async () => {
        await store.allocate(spec);
        await store.publish(spec, bytes());
        const remover = actor('remove', 'before_payload_rmdir');
        expect(await remover.next()).toMatchObject({ event: 'paused' });
        await rename(join(slot(), 'payload'), join(slot(), 'displaced'));
        await mkdir(join(slot(), 'payload'));
        const before = await stat(join(slot(), 'payload'));
        remover.resume();
        expect(await remover.next()).toMatchObject({ event: 'result', result: { status: 'pending' } });
        expect(await remover.exited).toBe(0);
        expect((await stat(join(slot(), 'payload'))).ino).toBe(before.ino);
    });
});

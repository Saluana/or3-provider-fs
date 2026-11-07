/** Failure inventory: live references must block deletion; interruption after
 * the durable claim or physical removal must retain the charge until a retry;
 * an incomplete removal must never acknowledge canonical completion. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _resetForTest, destroySqliteDb, getRawDb, initializeSqliteDb } from '../../sqlite/src/runtime/server/db/kysely';
import { runMigrations } from '../../sqlite/src/runtime/server/db/migrate';
import { SqliteExternalStorageGenerationUploadCoordinator } from '../../sqlite/src/runtime/server/storage/sqlite-generation-upload-coordinator';
import { createFsReclamationHandler, reclaimFsGeneration, reclaimFsGenerationBatch } from '../src/runtime/server/storage/fs-reclamation';

const content = Buffer.from('retained data');
const hash = createHash('sha256').update(content).digest('hex');
let root: string;
let coordinator: SqliteExternalStorageGenerationUploadCoordinator;
let target: { workspaceId: string; generationId: string; hash: string; sizeBytes: number };
let file: string;
beforeEach(async () => {
    _resetForTest();
    root = await mkdtemp(join(tmpdir(), 'or3-reclaim-operation-'));
    const db = await initializeSqliteDb({ path: join(root, 'db.sqlite'), driver: 'bun', journalMode: 'WAL', synchronous: 'FULL' });
    await runMigrations(db);
    coordinator = new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 'fs' });
    target = { workspaceId: 'workspace', generationId: randomUUID(), hash: 'sha256:' + hash, sizeBytes: content.length };
    file = join(root, 'blob');
    await writeFile(file, content);
    const upload = { ...target, storageId: 'fixture-' + target.generationId, intentId: randomUUID(), namespaceId: randomUUID(), userId: 'owner', mimeType: 'text/plain', expiresInSeconds: 60 };
    const ready = { ...upload, readyReceiptId: randomUUID() };
    await coordinator.reserveGenerationUpload(upload);
    await coordinator.markGenerationUploadReady(ready);
    await coordinator.publishGenerationUpload(ready);
    getRawDb().prepare('INSERT INTO s_file_meta (workspace_id,id,data_json,deleted) VALUES (?,?,?,0)')
        .run(target.workspaceId, hash, JSON.stringify({ hash, storage_id: 'fixture-' + target.generationId, size_bytes: content.length }));
});
afterEach(async () => { await destroySqliteDb(); await rm(root, { recursive: true, force: true }); });
const charge = () => (getRawDb().prepare('SELECT used_bytes FROM storage_usage WHERE workspace_id = ?').get('workspace') as { used_bytes: number }).used_bytes;

it('preserves referenced bytes and charge when the canonical claim is blocked', async () => {
    const remove = async () => { throw new Error('must not remove referenced data'); };
    expect(await reclaimFsGeneration({ target, claimId: 'claim', retentionSeconds: 0 }, { coordinator, store: { remove } })).toMatchObject({ status: 'blocked', reason: 'in_use' });
    expect(await readFile(file)).toEqual(content);
    expect(charge()).toBe(content.length);
});

it('resumes a removed payload after interruption and releases the charge once', async () => {
    getRawDb().exec('UPDATE s_file_meta SET deleted = 1');
    let interrupted = true;
    const remove = async () => {
        if (interrupted) { interrupted = false; await unlink(file); throw new Error('interrupted after unlink'); }
        return { status: 'already_absent' as const, removedEntries: 0 };
    };
    const input = { target, claimId: 'claim', retentionSeconds: 0 };
    await expect(reclaimFsGeneration(input, { coordinator, store: { remove } })).rejects.toThrow('interrupted');
    expect((await coordinator.getGeneration(target))?.state).toBe('claimed');
    expect(charge()).toBe(content.length);
    await destroySqliteDb();
    await initializeSqliteDb({ path: join(root, 'db.sqlite'), driver: 'bun', journalMode: 'WAL', synchronous: 'FULL' });
    coordinator = new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 'fs' });
    expect((await coordinator.getGeneration(target))?.state).toBe('claimed');
    expect(await reclaimFsGeneration(input, { coordinator, store: { remove } })).toMatchObject({ status: 'completed' });
    expect(charge()).toBe(0);
    expect(await reclaimFsGeneration(input, { coordinator, store: { remove } })).toMatchObject({ status: 'completed' });
    expect(charge()).toBe(0);
});

it('leaves the claim and charge intact when removal is incomplete', async () => {
    getRawDb().exec('UPDATE s_file_meta SET deleted = 1');
    const remove = async () => ({ status: 'pending' as const, removedEntries: 0, reason: 'unsafe_entry' });
    expect(await reclaimFsGeneration({ target, claimId: 'claim', retentionSeconds: 0 }, { coordinator, store: { remove } })).toMatchObject({ status: 'pending' });
    expect(await readFile(file)).toEqual(content);
    expect((await coordinator.getGeneration(target))?.state).toBe('claimed');
    expect(charge()).toBe(content.length);
});

it('rejects an unrecognized removal result without releasing the charge', async () => {
    getRawDb().exec('UPDATE s_file_meta SET deleted = 1');
    const remove = async () => ({ status: 'unknown', removedEntries: 0 } as never);
    await expect(reclaimFsGeneration({ target, claimId: 'claim', retentionSeconds: 0 }, { coordinator, store: { remove } })).rejects.toThrow();
    expect(charge()).toBe(content.length);
    expect(await readFile(file)).toEqual(content);
});

it('processes a bounded eligible page and leaves referenced files and accounting untouched', async () => {
    const remove = async () => { throw new Error('referenced bytes must not be removed'); };
    const result = await reclaimFsGenerationBatch({ workspaceId: 'workspace', retentionSeconds: 0, limit: 1 }, { coordinator, store: { remove } });
    expect(result).toMatchObject({ examined: 1, completed: 0, blocked: 1, pending: 0, complete: true });
    expect(await readFile(file)).toEqual(content);
    expect(charge()).toBe(content.length);
});

it('removes a bounded eligible page and reports the completed operation', async () => {
    getRawDb().exec('UPDATE s_file_meta SET deleted = 1');
    const remove = async () => { await unlink(file); return { status: 'removed' as const, removedEntries: 1 }; };
    const result = await reclaimFsGenerationBatch({ workspaceId: 'workspace', retentionSeconds: 0, limit: 1 }, { coordinator, store: { remove } });
    expect(result).toMatchObject({ examined: 1, completed: 1, blocked: 0, pending: 0, complete: true });
    expect(charge()).toBe(0);
});

it('only removes identities explicitly approved for the preview page', async () => {
    getRawDb().exec('UPDATE s_file_meta SET deleted = 1');
    const remove = async () => { await unlink(file); return { status: 'removed' as const, removedEntries: 1 }; };
    const input = { workspaceId: 'workspace', retentionSeconds: 0, limit: 1, generationIds: [randomUUID()] };
    await expect(reclaimFsGenerationBatch(input, { coordinator, store: { remove } })).rejects.toThrow('preview changed');
    expect(await readFile(file)).toEqual(content);
    expect(charge()).toBe(content.length);
    expect(await reclaimFsGenerationBatch({ ...input, generationIds: [target.generationId] }, { coordinator, store: { remove } })).toMatchObject({ completed: 1 });
    expect(charge()).toBe(0);
});

it('connects a qualified adapter callback to the canonical coordinator and preview selection', async () => {
    getRawDb().exec('UPDATE s_file_meta SET deleted = 1');
    const handler = createFsReclamationHandler({ remove: async () => { await unlink(file); return { status: 'removed' as const, removedEntries: 1 }; } });
    const input = { workspaceId: 'workspace', retentionSeconds: 0, limit: 1, generationIds: [target.generationId] };
    await expect(handler(input, { ...coordinator, version: 1, storageProviderId: 'fs' } as never)).rejects.toThrow();
    expect(charge()).toBe(content.length);
    expect(await handler(input, coordinator)).toMatchObject({ completed: 1 });
    expect(charge()).toBe(0);
});

it('does not advance past an incomplete removal and resumes its durable claim', async () => {
    getRawDb().exec('UPDATE s_file_meta SET deleted = 1');
    let pending = true;
    const remove = async () => {
        if (pending) { pending = false; return { status: 'pending' as const, removedEntries: 0, reason: 'temporary_failure' }; }
        await unlink(file);
        return { status: 'removed' as const, removedEntries: 1 };
    };
    const input = { workspaceId: 'workspace', retentionSeconds: 0, limit: 1 };
    expect(await reclaimFsGenerationBatch(input, { coordinator, store: { remove } })).toMatchObject({ pending: 1, complete: false, nextCursor: null });
    expect(charge()).toBe(content.length);
    expect(await reclaimFsGenerationBatch(input, { coordinator, store: { remove } })).toMatchObject({ completed: 1, pending: 0, complete: true });
    expect(charge()).toBe(0);
});


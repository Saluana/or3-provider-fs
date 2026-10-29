/** Test-only real process, database, and filesystem actor. Never a runtime route. */
import { createInterface } from 'node:readline';
import { initializeSqliteDb, destroySqliteDb } from '../../sqlite/src/runtime/server/db/kysely';
import { SqliteExternalStorageGenerationCoordinator } from '../../sqlite/src/runtime/server/storage/sqlite-generation-coordinator';
import { FsGenerationStore, type FsGenerationSpec } from '../src/runtime/server/storage/fs-generations';

const [mode, root, namespaceId, database, serialized, pause] = process.argv.slice(2);
if (!mode || !root || !namespaceId || !database || !serialized) throw new Error('Missing actor arguments');
const spec: FsGenerationSpec = JSON.parse(serialized);
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
let paused = false;
async function checkpoint(phase: string) {
    if (!paused && phase === pause) {
        paused = true;
        process.stdout.write(JSON.stringify({ event: 'paused', phase }) + '\n');
        const next = await lines.next();
        if (next.done || next.value !== 'resume') throw new Error('Actor not resumed');
    }
}
try {
    await initializeSqliteDb({ path: database, driver: 'bun', journalMode: 'WAL', synchronous: 'FULL' });
    const coordinator = new SqliteExternalStorageGenerationCoordinator({ storageProviderId: 'fs' });
    const store = new FsGenerationStore(root, namespaceId, { checkpoint });
    let result: unknown;
    if (mode === 'publish') {
        const receipt = await store.publish(spec, (async function* () { yield Buffer.from('immutable verified bytes'); })());
        const publication = await coordinator.registerVerifiedGeneration(receipt);
        if (publication.generation.state !== 'verified') throw new Error('Publication belongs to an irreversible old claim');
        result = publication;
    } else if (mode === 'remove') {
        const claim = await coordinator.claimGeneration({ ...spec, claimId: 'claim-one', retentionSeconds: 0 });
        if (claim.status === 'blocked') throw new Error('Claim refused: ' + claim.reason);
        await checkpoint('claim_committed');
        const removal = await store.remove(spec, 'claim-one', coordinator);
        // Completion is conditional on durable namespace absence, not unlink.
        if (removal.status !== 'pending') await coordinator.completeDeletion({ ...spec, claimId: 'claim-one' });
        result = removal;
    } else throw new Error('Unknown actor mode');
    process.stdout.write(JSON.stringify({ event: 'result', result }) + '\n');
} catch (error) {
    process.stdout.write(JSON.stringify({ event: 'error', message: String(error) }) + '\n');
    process.exitCode = 1;
} finally { input.close(); await destroySqliteDb(); }

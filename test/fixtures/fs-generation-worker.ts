/** Actual child-process actor for filesystem race/crash tests. No fake I/O. */
import { createInterface } from 'node:readline';
import { FsGenerationStore, type FsGenerationSpec } from '../../src/runtime/server/storage/fs-generations';

const [mode, root, namespaceId, serialized, pause] = process.argv.slice(2);
if (!mode || !root || !namespaceId || !serialized) throw new Error('Missing worker arguments');
const spec: FsGenerationSpec = JSON.parse(serialized);
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
let paused = false;
const store = new FsGenerationStore(root, namespaceId, { checkpoint: async phase => {
    if (!paused && phase === pause) {
        paused = true;
        process.stdout.write(JSON.stringify({ event: 'paused', phase }) + '\n');
        const next = await lines.next();
        if (next.done || next.value !== 'resume') throw new Error('Worker not resumed');
    }
} });
try {
    let result: unknown;
    if (mode === 'allocate') result = await store.allocate(spec);
    else if (mode === 'publish') result = await store.publish(spec, (async function* () {
        yield Buffer.from('immutable verified bytes');
    })());
    else if (mode === 'remove') result = await store.remove(spec, 'claim-one', {
        version: 1, storageProviderId: 'fs',
        getGeneration: async () => ({ ...spec, storageId: store.storageId(spec), state: 'claimed',
            claimId: 'claim-one', createdAt: 1, lastActivityAt: 1, claimedAt: 2 }),
    });
    else throw new Error('Unknown worker mode');
    process.stdout.write(JSON.stringify({ event: 'result', result }) + '\n');
} catch (error) {
    process.stdout.write(JSON.stringify({ event: 'error', message: String(error) }) + '\n');
    process.exitCode = 1;
} finally { input.close(); }

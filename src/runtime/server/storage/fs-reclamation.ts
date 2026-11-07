import type { ExternalStorageGenerationCoordinatorV1, ExternalStorageGenerationKey } from '~~/server/storage/gateway/generation-lifecycle';
import type { FsGenerationStore } from './fs-generations';
import type { StorageGenerationCandidatePage } from '~~/server/admin/stores/types';
import { randomUUID } from 'node:crypto';
type BatchInput = { workspaceId: string; retentionSeconds: number; limit: number; cursor?: string; generationIds?: string[] };
type BatchDependencies = { coordinator: ExternalStorageGenerationCoordinatorV1 & { inspectCandidates(input: BatchInput): Promise<StorageGenerationCandidatePage> }; store: Pick<FsGenerationStore, 'remove'> };

/** Internal, dormant operation. The persisted claim is its resume token; only
 * the provider's verified removal result can release canonical accounting. */
export async function reclaimFsGeneration(
    input: { target: ExternalStorageGenerationKey; claimId: string; retentionSeconds: number },
    deps: { coordinator: ExternalStorageGenerationCoordinatorV1; store: Pick<FsGenerationStore, 'remove'> },
) {
    const { coordinator, store } = deps;
    if (coordinator.version !== 1 || coordinator.storageProviderId !== 'fs') throw new Error('Filesystem reclamation requires a matching coordinator');
    const claim = await coordinator.claimGeneration({ ...input.target, claimId: input.claimId, retentionSeconds: input.retentionSeconds });
    if (claim.status === 'blocked') return claim;
    const generation = claim.generation;
    const target = { workspaceId: generation.workspaceId, generationId: generation.generationId, hash: generation.hash, sizeBytes: generation.sizeBytes };
    const removal = await store.remove(target, input.claimId, coordinator);
    if (removal.status === 'pending') return { status: 'pending' as const, reason: removal.reason };
    if (removal.status !== 'removed' && removal.status !== 'already_absent') throw new Error('Unrecognized filesystem removal result');
    const completion = await coordinator.completeDeletion({ ...target, claimId: input.claimId });
    return { status: 'completed' as const, completion: completion.status };
}

/** A single bounded page. Callers retain the cursor only after this page
 * completes; a crash replays the same page and resumes durable claims. */
export async function reclaimFsGenerationBatch(
    input: BatchInput,
    deps: BatchDependencies,
) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 || !Number.isSafeInteger(input.retentionSeconds) || input.retentionSeconds < 0) throw new Error('Invalid reclamation batch');
    const page = await deps.coordinator.inspectCandidates(input);
    if (page.workspaceId !== input.workspaceId || page.retentionSeconds !== input.retentionSeconds || page.items.length > input.limit || page.legacyIncluded !== false) throw new Error('Invalid reclamation inspection');
    if (input.generationIds?.some(id => !page.items.some(item => item.generation.generationId === id))) throw new Error('Reclamation preview changed; inspect again');
    const result = { examined: 0, completed: 0, blocked: 0, pending: 0, complete: page.complete, nextCursor: page.nextCursor };
    for (const item of page.items) {
        result.examined++;
        if (item.generation.workspaceId !== input.workspaceId) throw new Error('Invalid reclamation workspace');
        if (input.generationIds && !input.generationIds.includes(item.generation.generationId)) continue;
        if (item.status === 'blocked') { result.blocked++; continue; }
        if (item.status === 'deleted') continue;
        const claimId = item.status === 'claimed' ? item.generation.claimId : randomUUID();
        if (!claimId) throw new Error('Claimed generation has no claim identity');
        const operation = await reclaimFsGeneration({ target: item.generation, claimId, retentionSeconds: input.retentionSeconds }, deps);
        if (operation.status === 'completed') result.completed++;
        else if (operation.status === 'blocked') result.blocked++;
        else result.pending++;
    }
    if (result.pending) {
        result.complete = false;
        result.nextCursor = input.cursor ?? null;
    }
    return result;
}

/** Construct the host callback without advertising it or enabling cleanup. */
export function createFsReclamationHandler(store: Pick<FsGenerationStore, 'remove'>) {
    return async (input: BatchInput & { generationIds: string[] }, coordinator: ExternalStorageGenerationCoordinatorV1) => {
        if (!Array.isArray(input.generationIds) || input.generationIds.length < 1 || input.generationIds.length > input.limit ||
            new Set(input.generationIds).size !== input.generationIds.length) throw new Error('Invalid reclamation selection');
        const candidateCoordinator = coordinator as BatchDependencies['coordinator'];
        if (candidateCoordinator.version !== 1 || candidateCoordinator.storageProviderId !== 'fs' || typeof candidateCoordinator.inspectCandidates !== 'function') throw new Error('Filesystem reclamation coordinator unavailable');
        return reclaimFsGenerationBatch(input, { coordinator: candidateCoordinator, store });
    };
}


/** Bounded, read-only accounting. None of these observations authorize deletion. */
import type { H3Event } from 'h3';
import { lstat, opendir, realpath, statfs } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { getActiveSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { parseFsHash, parseFsStorageKey } from './fs-hash';
import { resolveFsWorkspacePath } from './fs-paths';

const PAGE_SIZE = 250;
const MAX_PAGES = 100;
const MAX_ENTRIES = 10_000;

type QueryKind = 'live_metadata' | 'retained_metadata' | 'active_reservations';
type CanonicalObservation = { bytes: number | null; complete: boolean; hashes: Map<string, boolean> };
type FileCategory = { files: number; apparentBytes: number | null };

function safeSum(left: number | null, right: number): number | null {
    const sum = left === null ? null : left + right;
    return sum !== null && Number.isSafeInteger(sum) && sum >= 0 ? sum : null;
}

function safeNumber(value: bigint): number | null {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

async function observeCanonical(
    event: H3Event,
    workspaceId: string,
    kind: QueryKind,
    now: number,
    warnings: Set<string>,
): Promise<CanonicalObservation> {
    const result: CanonicalObservation = { bytes: null, complete: false, hashes: new Map() };
    const sync = getActiveSyncGatewayAdapter();
    if (!sync?.queryCanonicalStorage || (kind === 'retained_metadata' && sync.capabilities?.retainedStorageMetadata !== 'v1')) {
        warnings.add(`canonical_${kind}_unsupported`);
        return result;
    }
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let total: number | null = 0;
    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            const response: unknown = await sync.queryCanonicalStorage(event, {
                scope: { workspaceId }, kind, cursor, limit: PAGE_SIZE, now,
            });
            if (!response || typeof response !== 'object') throw new Error('malformed_page');
            const body = response as Record<string, unknown>;
            if (!Array.isArray(body.items) || body.items.length > PAGE_SIZE || typeof body.hasMore !== 'boolean') throw new Error('malformed_page');
            for (const item of body.items) {
                if (!item || typeof item !== 'object') throw new Error('malformed_record');
                const record = item as Record<string, unknown>;
                const expectedKind = kind === 'live_metadata' ? 'metadata' : kind === 'retained_metadata' ? 'retained_metadata' : 'reservation';
                const hash = typeof record.hash === 'string' ? parseFsHash(record.hash)?.canonical : undefined;
                if (record.kind !== expectedKind || !hash) throw new Error('malformed_record');
                // Duplicate identities/aliases make the observation ambiguous, even
                // when their byte counts happen to agree during this scan.
                const identity = kind === 'active_reservations' ? record.reservationId : hash;
                if (typeof identity !== 'string' || !identity || seen.has(identity)) throw new Error('duplicate_identity');
                seen.add(identity);
                if (kind === 'active_reservations') {
                    if (typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt)) throw new Error('malformed_record');
                    if (record.expiresAt <= now) continue;
                }
                let filesystemIdentity = false;
                if (kind !== 'active_reservations') {
                    if (record.storageId === undefined) warnings.add(`canonical_${kind}_storage_identity_unknown`);
                    else if (typeof record.storageId === 'string' && record.storageId.startsWith(`${workspaceId}:`) &&
                        parseFsHash(record.storageId.slice(workspaceId.length + 1))?.canonical === hash) filesystemIdentity = true;
                    else warnings.add(`canonical_${kind}_storage_identity_mismatch`);
                }
                result.hashes.set(hash, filesystemIdentity);
                if (kind === 'retained_metadata' && record.sizeBytes === undefined) {
                    total = null;
                    warnings.add('canonical_retained_metadata_unknown_size');
                } else {
                    if (typeof record.sizeBytes !== 'number' || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) throw new Error('malformed_record');
                    const previous = total;
                    total = safeSum(total, record.sizeBytes);
                    if (previous !== null && total === null) throw new Error('unsafe_total');
                }
            }
            if (!body.hasMore) {
                if (body.nextCursor !== undefined) throw new Error('malformed_cursor');
                return { ...result, bytes: total, complete: true };
            }
            if (typeof body.nextCursor !== 'string' || !body.nextCursor || cursors.has(body.nextCursor)) throw new Error('invalid_cursor');
            cursors.add(body.nextCursor);
            cursor = body.nextCursor;
        }
        warnings.add(`canonical_${kind}_page_limit`);
    } catch {
        warnings.add(`canonical_${kind}_unavailable_or_malformed`);
    }
    // Retain only hashes observed before interruption; totals remain unknown.
    return result;
}

export async function observeFsStorageUsage(event: H3Event, workspaceId: string, payload?: Record<string, unknown>) {
    const startedAt = new Date().toISOString();
    const warnings = new Set<string>();
    const now = Math.floor(Date.now() / 1000);
    const active = await observeCanonical(event, workspaceId, 'live_metadata', now, warnings);
    const retained = await observeCanonical(event, workspaceId, 'retained_metadata', now, warnings);
    const reserved = await observeCanonical(event, workspaceId, 'active_reservations', now, warnings);
    const categories = {
        activeBlobs: { files: 0, apparentBytes: 0 } as FileCategory,
        retainedDeletedBlobs: { files: 0, apparentBytes: 0 } as FileCategory,
        incompleteTransfers: { files: 0, apparentBytes: 0 } as FileCategory,
        sidecars: { files: 0, apparentBytes: 0 } as FileCategory,
        unclassifiedFiles: { files: 0, apparentBytes: 0 } as FileCategory,
    };
    const filesystem = {
        complete: false,
        scannedEntries: 0,
        apparentFileBytes: null as number | null,
        allocatedFileBytes: null as number | null,
        categories,
    };
    let volume: { totalBytes: number | null; availableBytes: number | null; freeBytes: number | null } | null = null;
    const root = process.env.OR3_STORAGE_FS_ROOT;
    const rawLimit = payload?.limit;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(MAX_ENTRIES, Math.floor(rawLimit)) : MAX_ENTRIES;
    let workspace: string;
    try {
        if (!root || !isAbsolute(root)) throw new Error('Storage root not configured');
        const resolvedRoot = await realpath(root);
        workspace = resolveFsWorkspacePath(resolvedRoot, workspaceId);
        // Do not follow workspace aliases: a link may expose another workspace's
        // bytes even when its target stays inside the configured storage root.
        if (!(await lstat(workspace)).isDirectory()) throw new Error('Invalid workspace directory');
        const resolvedWorkspace = await realpath(workspace);
        if (!resolvedWorkspace.startsWith(resolvedRoot + sep) || resolvedWorkspace !== workspace) throw new Error('Invalid workspace directory');
        const inodes = new Set<string>();
        filesystem.apparentFileBytes = 0;
        filesystem.allocatedFileBytes = 0;
        filesystem.complete = true;
        const directory = await opendir(workspace);
        for await (const entry of directory) {
            if (filesystem.scannedEntries >= limit) {
                filesystem.complete = false;
                warnings.add('filesystem_entry_limit');
                break;
            }
            filesystem.scannedEntries++;
            try {
                const info = await lstat(join(workspace, entry.name), { bigint: true });
                if (!info.isFile()) {
                    filesystem.complete = false;
                    warnings.add('filesystem_non_regular_entry');
                    continue;
                }
                const size = safeNumber(info.size);
                const inode = `${info.dev}:${info.ino}`;
                const allocated = safeNumber(info.blocks * 512n);
                filesystem.apparentFileBytes = size === null ? null : safeSum(filesystem.apparentFileBytes, size);
                if (!inodes.has(inode)) {
                    inodes.add(inode);
                    filesystem.allocatedFileBytes = allocated === null ? null : safeSum(filesystem.allocatedFileBytes, allocated);
                }
                const hash = parseFsStorageKey(entry.name)?.canonical;
                let category = categories.unclassifiedFiles;
                if (/^(?:sha256_[a-f0-9]{64}|md5_[a-f0-9]{32})\.meta\.json$/i.test(entry.name)) category = categories.sidecars;
                else if (/^(?:sha256_[a-f0-9]{64}|md5_[a-f0-9]{32})(?:\.meta\.json)?\.tmp-/.test(entry.name)) category = categories.incompleteTransfers;
                else if (hash) {
                    const isActive = active.hashes.has(hash);
                    const isRetained = retained.hashes.has(hash);
                    if (isActive && isRetained) warnings.add('canonical_metadata_overlap');
                    // Incomplete scans cannot rule out overlapping active/deleted
                    // state, so incomplete or ambiguous ownership stays unclassified.
                    else if (active.complete && retained.complete) {
                        if (isActive && active.hashes.get(hash)) category = categories.activeBlobs;
                        else if (isRetained && retained.hashes.get(hash)) category = categories.retainedDeletedBlobs;
                    }
                }
                category.files++;
                category.apparentBytes = size === null ? null : safeSum(category.apparentBytes, size);
                if (filesystem.apparentFileBytes === null || filesystem.allocatedFileBytes === null || category.apparentBytes === null) {
                    warnings.add('filesystem_unsafe_total');
                    filesystem.complete = false;
                }
            } catch {
                filesystem.complete = false;
                warnings.add('filesystem_entry_unavailable');
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.add('filesystem_workspace_unavailable');
        else warnings.add('filesystem_workspace_missing');
        filesystem.complete = false;
    }
    if (root) {
        try {
            const info = await statfs(root, { bigint: true });
            volume = { totalBytes: safeNumber(info.blocks * info.bsize), availableBytes: safeNumber(info.bavail * info.bsize), freeBytes: safeNumber(info.bfree * info.bsize) };
            if (Object.values(volume).some(value => value === null)) warnings.add('volume_unsafe_total');
        } catch {
            warnings.add('volume_unavailable');
        }
    }
    return {
        startedAt, completedAt: new Date().toISOString(), consistency: 'non_atomic_observation',
        canonical: {
            activeMetadataBytes: active.bytes,
            retainedDeletedMetadataBytes: retained.bytes,
            reservedUploadBytes: reserved.bytes,
            complete: { activeMetadata: active.complete, retainedDeletedMetadata: retained.complete, reservedUploads: reserved.complete },
        },
        filesystem, volume, warnings: [...warnings],
    };
}

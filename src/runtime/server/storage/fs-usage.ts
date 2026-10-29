import type { H3Event } from 'h3';
import { createError } from 'h3';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath, stat, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { requireCan } from '~~/server/auth/can';
import { resolveSessionContext } from '~~/server/auth/session';
import { getActiveSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import type { CanonicalStorageQueryKind, CanonicalStorageRecord } from '~~/server/sync/gateway/types';
import { parseFsHash, parseFsStorageKey } from './fs-hash';
import { resolveFsWorkspacePath } from './fs-paths';

const DEFAULT_LIMIT = 10_000;
const MAX_LIMIT = 50_000;
type Metadata = { size?: number; retained: boolean };

function bound(value: number | undefined): number {
    if (value === undefined) return DEFAULT_LIMIT;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw createError({ statusCode: 400, statusMessage: 'Observation limit must be between 1 and ' + MAX_LIMIT });
    }
    return value;
}

function addBytes(total: number, amount: number): number {
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(total + amount)) {
        throw new Error('Invalid storage byte count');
    }
    return total + amount;
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
    return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino;
}

/** Use a pinned directory rather than reopening a mutable workspace pathname.
 * Unsupported descriptor views fail closed; they never fall back to a path
 * that could now name a different workspace.
 */
async function directoryView(handle: FileHandle, expected: BigIntStats): Promise<string> {
    for (const path of ['/proc/self/fd/' + handle.fd, '/dev/fd/' + handle.fd]) {
        try {
            if (sameDirectory(expected, await stat(path, { bigint: true }))) return path;
        } catch {
            // Try the other operating system's descriptor view.
        }
    }
    throw new Error('Pinned storage directory view unavailable');
}

/** Bounded, read-only observations. Never a GC candidate list or quota authority.
 * Canonical pages and filesystem stats are intentionally not called a snapshot:
 * uploads, restores, and reference writes can proceed during this operation.
 */
export async function observeFsStorageUsage(
    event: H3Event,
    workspaceId: string,
    options: { maxEntries?: number; maxMetadataRecords?: number } = {},
) {
    const startedAt = new Date().toISOString();
    const maxEntries = bound(options.maxEntries);
    const maxMetadataRecords = bound(options.maxMetadataRecords);
    const session = await resolveSessionContext(event);
    requireCan(session, 'workspace.read', { kind: 'workspace', id: workspaceId });
    const root = process.env.OR3_STORAGE_FS_ROOT;
    if (!root) throw createError({ statusCode: 503, statusMessage: 'Storage root not configured' });
    const workspacePath = resolveFsWorkspacePath(root, workspaceId);
    const resolvedRoot = await realpath(root);
    let workspaceMissing = false;
    let initialDirectory: BigIntStats | undefined;
    try {
        const directory = await lstat(workspacePath, { bigint: true });
        if (!directory.isDirectory()) {
            throw createError({ statusCode: 503, statusMessage: 'Unsafe storage workspace directory' });
        }
        const resolvedWorkspace = await realpath(workspacePath);
        if (resolvedWorkspace !== join(resolvedRoot, 'workspaces', workspaceId)) {
            throw createError({ statusCode: 503, statusMessage: 'Unsafe storage workspace directory' });
        }
        initialDirectory = directory;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        workspaceMissing = true;
    }

    const warnings = new Set<string>();
    if (workspaceMissing) warnings.add('workspace_directory_absent');
    const canonical = {
        complete: true,
        activeMetadataBytes: null as number | null,
        retainedDeletedMetadataBytes: null as number | null,
        reservedUploadBytes: null as number | null,
        unknownRetainedSizeCount: 0,
        recordsScanned: 0,
    };
    const metadata = new Map<string, Metadata>();
    const ambiguousHashes = new Set<string>();
    const sync = getActiveSyncGatewayAdapter();
    const retainedSupported = sync?.capabilities?.retainedStorageMetadata === 'v1';
    if (!retainedSupported) {
        canonical.complete = false;
        warnings.add('retained_metadata_unsupported');
    }

    const query = sync?.queryCanonicalStorage?.bind(sync);
    const kinds: CanonicalStorageQueryKind[] = ['live_metadata', 'active_reservations'];
    if (retainedSupported) kinds.push('retained_metadata');
    if (!query) {
        canonical.complete = false;
        warnings.add('canonical_query_unavailable');
    } else {
        const now = Math.floor(Date.now() / 1000);
        for (const kind of kinds) {
            if (canonical.recordsScanned >= maxMetadataRecords) {
                canonical.complete = false;
                warnings.add('canonical_record_limit');
                break;
            }
            const records = new Map<string, CanonicalStorageRecord>();
            const cursors = new Set<string>();
            let cursor: string | undefined;
            let total = 0;
            let unknownSizes = 0;
            try {
                for (let pageNumber = 0; ; pageNumber++) {
                    if (pageNumber >= 1000) throw new Error('Canonical page limit');
                    const limit = Math.min(500, maxMetadataRecords - canonical.recordsScanned);
                    if (limit <= 0) {
                        warnings.add('canonical_record_limit');
                        throw new Error('Canonical record limit');
                    }
                    const page = await query(event, { scope: { workspaceId }, kind, cursor, limit, now });
                    if (!Array.isArray(page.items) || page.items.length > limit || typeof page.hasMore !== 'boolean') {
                        throw new Error('Invalid canonical page');
                    }
                    for (const item of page.items) {
                        canonical.recordsScanned++;
                        const expectedKind = kind === 'live_metadata' ? 'metadata' : kind === 'retained_metadata' ? 'retained_metadata' : 'reservation';
                        if (item.kind === 'reference' || item.kind !== expectedKind) throw new Error('Unexpected canonical record');
                        const hash = parseFsHash(item.hash)?.canonical;
                        if (!hash) throw new Error('Invalid canonical hash');
                        const key = item.kind === 'reservation' ? item.reservationId : hash;
                        if (typeof key !== 'string' || !key) throw new Error('Missing canonical identity');
                        const size = item.sizeBytes;
                        if (size === undefined && item.kind !== 'retained_metadata') throw new Error('Missing canonical size');
                        if (size !== undefined) addBytes(0, size);
                        const previous = records.get(key);
                        if (previous) {
                            if (previous.kind === 'reference' || previous.sizeBytes !== size ||
                                parseFsHash(previous.hash)?.canonical !== hash) {
                                throw new Error('Conflicting canonical identity');
                            }
                            continue;
                        }
                        records.set(key, item);
                        if (size === undefined) unknownSizes++;
                        else total = addBytes(total, size);
                    }
                    if (!page.hasMore) break;
                    if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) {
                        throw new Error('Invalid canonical cursor');
                    }
                    cursors.add(page.nextCursor);
                    cursor = page.nextCursor;
                }
                if (kind === 'active_reservations') canonical.reservedUploadBytes = total;
                else {
                    for (const [hash, item] of records) {
                        if (metadata.has(hash)) {
                            metadata.delete(hash);
                            ambiguousHashes.add(hash);
                            canonical.complete = false;
                            warnings.add('canonical_state_changed');
                        } else if (!ambiguousHashes.has(hash) && item.kind !== 'reference' && item.kind !== 'reservation') {
                            metadata.set(hash, { size: item.sizeBytes, retained: kind === 'retained_metadata' });
                        }
                    }
                    if (kind === 'live_metadata') canonical.activeMetadataBytes = total;
                    else {
                        canonical.retainedDeletedMetadataBytes = unknownSizes ? null : total;
                        canonical.unknownRetainedSizeCount = unknownSizes;
                        if (unknownSizes) { canonical.complete = false; warnings.add('retained_metadata_size_unknown'); }
                    }
                }
            } catch {
                canonical.complete = false;
                warnings.add('canonical_query_failed');
                // Discard this entire view on error: partial sums look like
                // reliable zeroes and must not become an accounting result.
            }
        }
    }
    if (ambiguousHashes.size) {
        canonical.activeMetadataBytes = null;
        canonical.retainedDeletedMetadataBytes = null;
    }

    const filesystem = {
        complete: true,
        entriesScanned: 0,
        skippedEntries: 0,
        hardlinkAliases: 0,
        activeBlobBytes: 0,
        retainedDeletedBlobBytes: 0,
        incompleteTransferBytes: 0,
        sidecarBytes: 0,
        unclassifiedBytes: 0,
        apparentFileBytes: 0,
        allocatedFileBytes: 0 as number | null,
        orphanSidecarCount: 0 as number | null,
    };
    const files = new Map<string, number>();
    const inodes = new Set<string>();
    if (!workspaceMissing) {
        try {
            if (!initialDirectory || typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') {
                throw new Error('Safe storage directory observation unavailable');
            }
            const workspaceHandle = await open(workspacePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
            try {
                const openedDirectory = await workspaceHandle.stat({ bigint: true });
                if (!sameDirectory(initialDirectory, openedDirectory)) throw new Error('Storage workspace changed');
                const pinnedPath = await directoryView(workspaceHandle, openedDirectory);
                const directory = await opendir(pinnedPath);
                for await (const entry of directory) {
                    if (filesystem.entriesScanned >= maxEntries) {
                        filesystem.complete = false;
                        warnings.add('filesystem_entry_limit');
                        break;
                    }
                    filesystem.entriesScanned++;
                    if (!entry.isFile()) {
                        filesystem.skippedEntries++;
                        filesystem.complete = false;
                        warnings.add('non_regular_entry');
                        continue;
                    }
                    try {
                        // No contents or sidecar JSON are read. NONBLOCK also
                        // prevents a file-to-FIFO race from hanging the scan.
                        const handle = await open(join(pinnedPath, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                        let file: BigIntStats;
                        try {
                            file = await handle.stat({ bigint: true });
                            if (!file.isFile()) throw new Error('Storage entry changed');
                        } finally { await handle.close(); }
                        const size = Number(file.size);
                        const apparent = addBytes(filesystem.apparentFileBytes, size);
                        const inode = file.dev + ':' + file.ino;
                        const alias = inodes.has(inode);
                        let allocated = filesystem.allocatedFileBytes;
                        if (!alias && allocated !== null) {
                            try {
                                if (typeof file.blocks !== 'bigint') throw new Error('Allocation unavailable');
                                allocated = addBytes(allocated, Number(file.blocks * 512n));
                            } catch {
                                allocated = null;
                                warnings.add('allocated_bytes_unavailable');
                            }
                        }
                        // Commit an entry's counters only after validating it.
                        filesystem.apparentFileBytes = apparent;
                        filesystem.allocatedFileBytes = allocated;
                        files.set(entry.name, size);
                        if (alias) filesystem.hardlinkAliases++;
                        else inodes.add(inode);
                    } catch {
                        filesystem.complete = false;
                        filesystem.skippedEntries++;
                        warnings.add('filesystem_entry_unreadable_or_changed');
                    }
                }
            } finally { await workspaceHandle.close(); }
        } catch {
            filesystem.complete = false;
            warnings.add('filesystem_directory_unreadable_or_changed');
        }
    }
    if (!filesystem.complete) filesystem.orphanSidecarCount = null;
    for (const [name, size] of files) {
        const temporaryBase = name.split('.tmp-')[0]?.replace(/\.meta\.json$/, '');
        if (name.includes('.tmp-') && temporaryBase && parseFsStorageKey(temporaryBase)) {
            filesystem.incompleteTransferBytes = addBytes(filesystem.incompleteTransferBytes, size);
        } else if (name.endsWith('.meta.json') && parseFsStorageKey(name.slice(0, -'.meta.json'.length))) {
            filesystem.sidecarBytes = addBytes(filesystem.sidecarBytes, size);
            if (filesystem.orphanSidecarCount !== null && !files.has(name.slice(0, -'.meta.json'.length))) filesystem.orphanSidecarCount++;
        } else {
            const hash = parseFsStorageKey(name)?.canonical;
            const row = hash ? metadata.get(hash) : undefined;
            if (!hash) filesystem.unclassifiedBytes = addBytes(filesystem.unclassifiedBytes, size);
            // A bounded scan may simply not have visited the sidecar yet.
            else if (!files.has(name + '.meta.json') && filesystem.complete) {
                filesystem.incompleteTransferBytes = addBytes(filesystem.incompleteTransferBytes, size);
            } else if (!files.has(name + '.meta.json') || !row || row.size !== size) {
                filesystem.unclassifiedBytes = addBytes(filesystem.unclassifiedBytes, size);
            } else if (row.retained) filesystem.retainedDeletedBlobBytes = addBytes(filesystem.retainedDeletedBlobBytes, size);
            else filesystem.activeBlobBytes = addBytes(filesystem.activeBlobBytes, size);
        }
    }

    let volume: { totalBytes: number; availableBytes: number } | null = null;
    try {
        const stats = await statfs(root, { bigint: true });
        volume = {
            totalBytes: addBytes(0, Number(stats.blocks * stats.bsize)),
            availableBytes: addBytes(0, Number(stats.bavail * stats.bsize)),
        };
    } catch { warnings.add('volume_usage_unavailable'); }
    return {
        version: 1 as const,
        workspaceId,
        startedAt,
        finishedAt: new Date().toISOString(),
        consistency: 'non_atomic_observation' as const,
        physicalCleanupEnabled: false,
        canonical,
        filesystem,
        volume,
        warnings: [...warnings],
    };
}

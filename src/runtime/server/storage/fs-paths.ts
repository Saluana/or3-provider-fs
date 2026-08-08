/**
 * @module fs-paths
 *
 * Safe filesystem path resolution for blob storage.
 * All paths are validated to stay under the configured storage root
 * to prevent directory traversal attacks.
 */
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve, join, normalize, sep } from 'node:path';
import { requireFsHash } from './fs-hash';

const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_-]+$/;

function assertWithinRoot(root: string, path: string): void {
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    if (resolvedPath === resolvedRoot) return;
    if (!resolvedPath.startsWith(resolvedRoot + sep)) {
        throw new Error('Invalid storage path');
    }
}

/**
 * Open a managed object for a signed download without following a final
 * symlink. The lexical path is not enough here: an attacker who can write to
 * the storage volume could replace a valid object with a link between token
 * verification and the read. Resolve the configured root and candidate first,
 * then use O_NOFOLLOW and verify the opened descriptor's target where the host
 * exposes a proc/dev fd view.
 */
export async function openFsObjectForDownload(root: string, objectPath: string): Promise<FileHandle> {
    const resolvedRoot = await realpath(root);
    const resolvedObject = await realpath(objectPath);
    assertWithinRoot(resolvedRoot, resolvedObject);

    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = await open(objectPath, fsConstants.O_RDONLY | noFollow);
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
            throw new Error('Storage object is not a regular file');
        }

        // Linux exposes /proc/self/fd and macOS exposes /dev/fd. Checking the
        // descriptor catches a rename/symlink swap that happened after the
        // path realpath check but before the open completed.
        for (const descriptorPath of [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]) {
            try {
                const openedPath = await realpath(descriptorPath);
                // Some macOS/Bun combinations expose a synthetic /dev/fd
                // target rather than the opened path. O_NOFOLLOW still
                // protects the final component; skip only this unverifiable
                // descriptor view and try the next one.
                if (openedPath.startsWith('/dev/fd/')) continue;
                assertWithinRoot(resolvedRoot, openedPath);
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
            }
        }

        return handle;
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}

export function assertValidWorkspaceId(workspaceId: string): void {
    if (!SAFE_WORKSPACE_ID.test(workspaceId)) {
        throw new Error('Invalid workspace ID');
    }
}

export function resolveFsWorkspacePath(root: string, workspaceId: string): string {
    assertValidWorkspaceId(workspaceId);
    const normalized = normalize(join(root, 'workspaces', workspaceId));
    assertWithinRoot(root, normalized);
    return resolve(normalized);
}

/**
 * Resolve a safe object path under the storage root.
 *
 * Layout: `<root>/workspaces/<workspaceId>/<hash>`
 *
 * @throws If workspace ID or hash contain unsafe characters,
 *         or if the resolved path escapes the root.
 */
export function resolveFsObjectPath(root: string, workspaceId: string, hash: string): string {
    assertValidWorkspaceId(workspaceId);
    const parsedHash = requireFsHash(hash);

    const normalized = normalize(join(root, 'workspaces', workspaceId, parsedHash.storageKey));
    assertWithinRoot(root, normalized);
    return resolve(normalized);
}

export function getFsObjectMetadataPath(objectPath: string): string {
    return `${objectPath}.meta.json`;
}

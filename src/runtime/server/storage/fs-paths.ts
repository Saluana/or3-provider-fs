/**
 * @module fs-paths
 *
 * Safe filesystem path resolution for blob storage.
 * All paths are validated to stay under the configured storage root
 * to prevent directory traversal attacks.
 */
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

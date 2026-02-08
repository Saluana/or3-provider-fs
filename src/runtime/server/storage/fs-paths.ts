/**
 * @module fs-paths
 *
 * Safe filesystem path resolution for blob storage.
 * All paths are validated to stay under the configured storage root
 * to prevent directory traversal attacks.
 */
import { resolve, join, normalize, sep } from 'node:path';

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Resolve a safe object path under the storage root.
 *
 * Layout: `<root>/workspaces/<workspaceId>/<hash>`
 *
 * @throws If workspace ID or hash contain unsafe characters,
 *         or if the resolved path escapes the root.
 */
export function resolveFsObjectPath(root: string, workspaceId: string, hash: string): string {
    if (!SAFE_ID.test(workspaceId)) {
        throw new Error('Invalid workspace ID');
    }
    if (!SAFE_ID.test(hash)) {
        throw new Error('Invalid hash');
    }

    const normalized = normalize(join(root, 'workspaces', workspaceId, hash));
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(normalized);

    if (!resolvedPath.startsWith(resolvedRoot + sep)) {
        throw new Error('Invalid storage path');
    }

    return resolvedPath;
}

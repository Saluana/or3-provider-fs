/**
 * PUT /api/storage/fs/upload?token=...
 *
 * Receives a binary body and writes it atomically to the filesystem
 * using temp-file + rename. Token is verified for operation scope,
 * workspace, hash, and optional size constraint.
 */
import { defineEventHandler, getQuery, readRawBody, createError } from 'h3';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { verifyFsToken } from '../../../storage/fs-token';
import { resolveFsObjectPath } from '../../../storage/fs-paths';

export default defineEventHandler(async (event) => {
    const token = String(getQuery(event).token || '');
    if (!token) throw createError({ statusCode: 400, statusMessage: 'Missing token' });

    let claims;
    try {
        claims = verifyFsToken(token);
    } catch {
        throw createError({ statusCode: 403, statusMessage: 'Invalid or expired token' });
    }

    if (claims.op !== 'upload') {
        throw createError({ statusCode: 403, statusMessage: 'Invalid operation token' });
    }

    const root = process.env.OR3_STORAGE_FS_ROOT;
    if (!root) throw createError({ statusCode: 500, statusMessage: 'Storage root not configured' });

    let target: string;
    try {
        target = resolveFsObjectPath(root, claims.workspace_id, claims.hash);
    } catch {
        throw createError({ statusCode: 400, statusMessage: 'Invalid path parameters' });
    }

    const body = await readRawBody(event, false);
    if (!body) throw createError({ statusCode: 400, statusMessage: 'Missing upload body' });

    if (claims.size_bytes && body.length > claims.size_bytes) {
        throw createError({ statusCode: 413, statusMessage: 'Payload too large' });
    }

    // Atomic write: temp → rename
    const temp = `${target}.tmp-${Date.now()}`;
    await mkdir(dirname(target), { recursive: true });
    try {
        await writeFile(temp, body);
        await rename(temp, target);
    } catch (err) {
        // Clean up temp on failure
        await unlink(temp).catch(() => {});
        throw createError({ statusCode: 500, statusMessage: 'Write failed' });
    }

    return { ok: true, storage_id: `${claims.workspace_id}:${claims.hash}` };
});

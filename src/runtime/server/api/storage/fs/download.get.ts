/**
 * GET /api/storage/fs/download?token=...
 *
 * Streams a file from the filesystem. Token is verified for
 * operation scope, workspace, and hash.
 */
import { defineEventHandler, getQuery, createError, sendStream } from 'h3';
import { createReadStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
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

    if (claims.op !== 'download') {
        throw createError({ statusCode: 403, statusMessage: 'Invalid operation token' });
    }

    const root = process.env.OR3_STORAGE_FS_ROOT;
    if (!root) throw createError({ statusCode: 500, statusMessage: 'Storage root not configured' });

    let filePath: string;
    try {
        filePath = resolveFsObjectPath(root, claims.workspace_id, claims.hash);
    } catch {
        throw createError({ statusCode: 400, statusMessage: 'Invalid path parameters' });
    }

    try {
        await access(filePath, constants.R_OK);
    } catch {
        throw createError({ statusCode: 404, statusMessage: 'File not found' });
    }

    return sendStream(event, createReadStream(filePath));
});

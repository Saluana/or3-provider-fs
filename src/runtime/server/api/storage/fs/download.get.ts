/**
 * GET /api/storage/fs/download?token=...
 *
 * Streams a file from the filesystem. Token is verified for
 * operation scope, workspace, and hash.
 */
import { eventHandler, getQuery, createError, sendStream, setResponseHeader } from 'h3';
import { createReadStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { requireCan } from '~~/server/auth/can';
import { resolveSessionContext } from '~~/server/auth/session';
import { verifyFsToken } from '../../../storage/fs-token';
import { resolveFsObjectPath } from '../../../storage/fs-paths';

export default eventHandler(async (event) => {
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

    const session = await resolveSessionContext(event);
    if (!session.authenticated || !session.user) {
        throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
    }
    if (claims.user_id !== session.user.id) {
        throw createError({ statusCode: 403, statusMessage: 'Invalid token subject' });
    }
    requireCan(session, 'workspace.read', {
        kind: 'workspace',
        id: claims.workspace_id,
    });

    const root = process.env.OR3_STORAGE_FS_ROOT;
    if (!root) throw createError({ statusCode: 500, statusMessage: 'Storage root not configured' });
    if (!isAbsolute(root)) throw createError({ statusCode: 500, statusMessage: 'Storage root must be absolute' });

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

    if (claims.mime_type) {
        setResponseHeader(event, 'Content-Type', claims.mime_type);
    }

    return sendStream(event, createReadStream(filePath));
});

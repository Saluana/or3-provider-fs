/**
 * GET /api/storage/fs/download?token=...
 *
 * Streams a file from the filesystem. Token is verified for
 * operation scope, workspace, and hash.
 */
import { eventHandler, getQuery, createError, sendStream, setResponseHeader } from 'h3';
import { isAbsolute } from 'node:path';
import { requireCan } from '~~/server/auth/can';
import { resolveSessionContext } from '~~/server/auth/session';
import { verifyFsToken } from '../../../storage/fs-token';
import { openFsObjectForDownload, resolveFsObjectPath } from '../../../storage/fs-paths';

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

    let fileHandle;
    try {
        fileHandle = await openFsObjectForDownload(root, filePath);
    } catch {
        throw createError({ statusCode: 404, statusMessage: 'File not found' });
    }

    const normalizedMime = claims.mime_type?.split(';', 1)[0]?.trim().toLowerCase();
    const safeInlineMime = normalizedMime === 'image/png' ||
        normalizedMime === 'image/jpeg' ||
        normalizedMime === 'image/webp' ||
        normalizedMime === 'image/gif' ||
        normalizedMime === 'application/pdf';
    const safeMime = safeInlineMime ? normalizedMime : 'application/octet-stream';
    const disposition = safeInlineMime && claims.disposition === 'inline'
        ? 'inline'
        : 'attachment';
    const filename = (claims.filename ?? 'download')
        .replace(/[\u0000-\u001f\u007f]/g, '_')
        .replace(/[\\/]+/g, '_')
        .slice(0, 180) || 'download';
    setResponseHeader(event, 'Content-Type', safeMime);
    setResponseHeader(event, 'Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
    setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
    setResponseHeader(event, 'Cache-Control', 'private, no-store');

    return sendStream(event, fileHandle.createReadStream());
});

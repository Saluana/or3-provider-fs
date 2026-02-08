/**
 * PUT /api/storage/fs/upload?token=...
 *
 * Receives a binary body and writes it atomically to the filesystem
 * using temp-file + rename. Token is verified for operation scope,
 * workspace, hash, and optional size constraint.
 */
import { defineEventHandler, getHeader, getQuery, createError } from 'h3';
import type { H3Event } from 'h3';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { requireCan } from '~~/server/auth/can';
import { resolveSessionContext } from '~~/server/auth/session';
import { createFsHashDigestVerifier } from '../../../storage/fs-hash';
import { verifyFsToken } from '../../../storage/fs-token';
import { resolveFsObjectPath } from '../../../storage/fs-paths';

class UploadValidationError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

function normalizeMime(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const mime = value.split(';', 1)[0]?.trim().toLowerCase();
    return mime || undefined;
}

function getRequestBodyStream(event: H3Event): Readable | null {
    const nodeReq = event?.node?.req;
    if (nodeReq && typeof nodeReq.pipe === 'function') {
        return nodeReq as Readable;
    }

    const webBody = (event as unknown as { req?: { body?: NodeReadableStream | null } })?.req?.body;
    if (webBody) {
        return Readable.fromWeb(webBody);
    }

    return null;
}

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

    const session = await resolveSessionContext(event);
    if (!session.authenticated || !session.user) {
        throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
    }
    if (claims.user_id !== session.user.id) {
        throw createError({ statusCode: 403, statusMessage: 'Invalid token subject' });
    }
    requireCan(session, 'workspace.write', {
        kind: 'workspace',
        id: claims.workspace_id,
    });

    const root = process.env.OR3_STORAGE_FS_ROOT;
    if (!root) throw createError({ statusCode: 500, statusMessage: 'Storage root not configured' });
    if (!isAbsolute(root)) throw createError({ statusCode: 500, statusMessage: 'Storage root must be absolute' });

    let target: string;
    try {
        target = resolveFsObjectPath(root, claims.workspace_id, claims.hash);
    } catch {
        throw createError({ statusCode: 400, statusMessage: 'Invalid path parameters' });
    }

    const expectedMime = normalizeMime(claims.mime_type);
    const requestMime = normalizeMime(getHeader(event, 'content-type'));
    if (expectedMime) {
        if (!requestMime || requestMime !== expectedMime) {
            throw createError({ statusCode: 415, statusMessage: 'Content type mismatch' });
        }
    }

    // Atomic write: temp → rename
    const temp = `${target}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const bodyStream = getRequestBodyStream(event);
    if (!bodyStream) throw createError({ statusCode: 400, statusMessage: 'Missing upload body' });

    const digest = createFsHashDigestVerifier(claims.hash);
    const maxBytes = claims.size_bytes;
    let writtenBytes = 0;
    const verifier = new Transform({
        transform(chunk, _encoding, callback) {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            writtenBytes += data.length;

            if (maxBytes !== undefined && writtenBytes > maxBytes) {
                callback(new UploadValidationError(413, 'Payload too large'));
                return;
            }

            digest.update(data);
            callback(null, data);
        },
    });

    await mkdir(dirname(target), { recursive: true });
    try {
        await pipeline(bodyStream, verifier, createWriteStream(temp, { flags: 'wx' }));

        if (writtenBytes === 0) {
            throw new UploadValidationError(400, 'Missing upload body');
        }
        if (!digest.finalize()) {
            throw new UploadValidationError(400, 'Hash mismatch');
        }

        await rename(temp, target);
    } catch (err) {
        // Clean up temp on failure
        await unlink(temp).catch(() => {});
        if (err instanceof UploadValidationError) {
            throw createError({ statusCode: err.statusCode, statusMessage: err.message });
        }
        throw createError({ statusCode: 500, statusMessage: 'Write failed' });
    }

    return { ok: true, storage_id: `${claims.workspace_id}:${claims.hash}` };
});

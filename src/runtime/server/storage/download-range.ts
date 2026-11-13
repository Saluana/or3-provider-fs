import { createError, getHeader, removeResponseHeader, setResponseHeader, setResponseStatus, type H3Event } from 'h3';

/** Apply a single byte range after authorization. Invalid/multiple ranges are ignored. */
export function applyDownloadRange(event: H3Event, size: number, etag: string): { start: number; end: number } | null {
    setResponseHeader(event, 'ETag', etag);
    setResponseHeader(event, 'Accept-Ranges', 'bytes');
    setResponseHeader(event, 'Content-Length', size);
    const requested = getHeader(event, 'range');
    if (!requested || (getHeader(event, 'if-range') && getHeader(event, 'if-range') !== etag)) return null;
    const match = /^bytes=(\d*)-(\d*)$/i.exec(requested.trim());
    if (!match || (!match[1] && !match[2])) return null;
    const first = match[1] ? Number(match[1]) : null;
    const last = match[2] ? Number(match[2]) : null;
    if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
    const start = first ?? Math.max(0, size - (last ?? 0));
    const end = first === null ? size - 1 : Math.min(last ?? size - 1, size - 1);
    if (size === 0 || start >= size || start > end) {
        removeResponseHeader(event, 'Content-Length');
        setResponseHeader(event, 'Content-Range', `bytes */${size}`);
        throw createError({ statusCode: 416, statusMessage: 'Range Not Satisfiable' });
    }
    setResponseStatus(event, 206);
    setResponseHeader(event, 'Content-Range', `bytes ${start}-${end}/${size}`);
    setResponseHeader(event, 'Content-Length', end - start + 1);
    return { start, end };
}

/** Dormant generation credentials. Distinct operations also make these tokens
 * invalid at legacy FS endpoints, even if an operator uses the same secret.
 * Token possession never replaces current session/intent authorization.
 */
import jwt from 'jsonwebtoken';

export type FsGenerationOperation = 'generation_upload' | 'generation_download';
export interface FsGenerationTokenIdentity {
    workspaceId: string;
    userId: string;
    generationId: string;
    /** Upload authorization only. Downloads bind the current reader instead. */
    intentId?: string;
    /** Canonical safe policy selected at presign; download-only. */
    disposition?: 'inline' | 'attachment';
    hash: string;
    sizeBytes: number;
    mimeType: string;
}
export interface FsGenerationTokenClaims extends FsGenerationTokenIdentity {
    version: 1;
    operation: FsGenerationOperation;
    storageProviderId: 'fs';
    syncProviderId: string;
    namespaceId: string;
    issuedAt: number;
    expiresAt: number;
}

const AUDIENCE = 'or3:fs:generations:v1';
const ISSUER = 'or3-fs-generation';
const MAX_LIFETIME_SECONDS = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = new Set(['version', 'op', 'storage_provider_id', 'sync_provider_id', 'namespace_id',
    'workspace_id', 'user_id', 'generation_id', 'intent_id', 'disposition', 'hash', 'size_bytes', 'mime_type', 'iat', 'exp', 'aud', 'iss']);

function invalid(): never { throw new Error('Invalid filesystem generation credential'); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function subject(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

export function createFsGenerationTokenCodec(options: {
    secret: string; namespaceId: string; syncProviderId: string; now?: () => number;
}) {
    if (typeof options.secret !== 'string' || Buffer.byteLength(options.secret) < 32 ||
        !UUID.test(options.namespaceId) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.syncProviderId)) invalid();
    const currentTime = () => {
        const time = options.now ? options.now() : Math.floor(Date.now() / 1000);
        if (!integer(time)) invalid();
        return time;
    };
    function parse(value: unknown, operation: FsGenerationOperation, now: number): FsGenerationTokenClaims {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
        const body = value as Record<string, unknown>;
        if (Object.keys(body).some(key => !FIELDS.has(key)) || body.version !== 1 ||
            (operation !== 'generation_upload' && operation !== 'generation_download') || body.op !== operation ||
            body.aud !== AUDIENCE || body.iss !== ISSUER || body.storage_provider_id !== 'fs' ||
            body.sync_provider_id !== options.syncProviderId || body.namespace_id !== options.namespaceId ||
            typeof body.workspace_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.workspace_id) ||
            !subject(body.user_id) || typeof body.generation_id !== 'string' || !UUID.test(body.generation_id) ||
            (operation === 'generation_upload'
                ? typeof body.intent_id !== 'string' || !UUID.test(body.intent_id)
                : body.intent_id !== undefined) ||
            (operation === 'generation_upload' ? body.disposition !== undefined : body.disposition !== 'inline' && body.disposition !== 'attachment') ||
            typeof body.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.hash) || !integer(body.size_bytes) ||
            typeof body.mime_type !== 'string' || body.mime_type.length > 255 ||
            !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(body.mime_type) ||
            !integer(body.iat) || !integer(body.exp) || body.iat > now || body.exp <= now ||
            body.exp <= body.iat || body.exp - body.iat > MAX_LIFETIME_SECONDS) invalid();
        return {
            version: 1, operation, storageProviderId: 'fs', syncProviderId: options.syncProviderId,
            namespaceId: options.namespaceId, workspaceId: body.workspace_id, userId: body.user_id,
            generationId: body.generation_id, ...(typeof body.intent_id === 'string' ? { intentId: body.intent_id } : {}), hash: body.hash,
            ...(body.disposition === 'inline' || body.disposition === 'attachment' ? { disposition: body.disposition } : {}),
            sizeBytes: body.size_bytes, mimeType: body.mime_type, issuedAt: body.iat, expiresAt: body.exp,
        };
    }
    return {
        sign(identity: FsGenerationTokenIdentity, operation: FsGenerationOperation, expiresAt: number): string {
            const now = currentTime();
            const payload = {
                version: 1, op: operation, storage_provider_id: 'fs', sync_provider_id: options.syncProviderId,
                namespace_id: options.namespaceId, workspace_id: identity.workspaceId, user_id: identity.userId,
                generation_id: identity.generationId, intent_id: identity.intentId, hash: identity.hash,
                disposition: identity.disposition,
                size_bytes: identity.sizeBytes, mime_type: identity.mimeType, iat: now, exp: expiresAt,
                aud: AUDIENCE, iss: ISSUER,
            };
            parse(payload, operation, now);
            return jwt.sign(payload, options.secret, { algorithm: 'HS256' });
        },
        verify(token: string, operation: FsGenerationOperation): FsGenerationTokenClaims {
            if (typeof token !== 'string' || token.length > 4096) invalid();
            const now = currentTime();
            return parse(jwt.verify(token, options.secret, {
                algorithms: ['HS256'], audience: AUDIENCE, issuer: ISSUER,
                clockTimestamp: now, clockTolerance: 0,
            }), operation, now);
        },
    };
}

/** Failure cases: credential downgrade to legacy paths, foreign provider or
 * namespace replay, altered immutable identity, expiry and malformed claims.
 * Dormant factories are tested separately from the unchanged legacy endpoints.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createFsGenerationTokenCodec } from '../server/storage/fs-generation-token';
import { signFsToken, verifyFsToken } from '../server/storage/fs-token';
import { createFsGenerationGateway } from '../server/storage/fs-generation-gateway';

// No authentication backend is contacted by the dormant/token suite.
vi.mock('~~/server/auth/session', () => ({ resolveSessionContext: vi.fn() }));

const secret = 'generation-transfer-test-secret-with-sufficient-length';
const namespaceId = randomUUID();
const identity = {
    workspaceId: 'workspace', userId: 'internal-user', generationId: randomUUID(),
    intentId: randomUUID(), hash: 'sha256:' + 'a'.repeat(64), sizeBytes: 12, mimeType: 'text/plain',
};
const now = () => Math.floor(Date.now() / 1000);
const codec = () => createFsGenerationTokenCodec({ secret, namespaceId, syncProviderId: 'sqlite', now });

afterEach(() => { delete process.env.OR3_STORAGE_FS_TOKEN_SECRET; });

describe('unregistered generation factories', () => {
    it.each([undefined, false])('defaults disabled before resolving dependencies or touching requests (%s)', async enabled => {
        const resolve = vi.fn(() => { throw new Error('Dependency must not be resolved'); });
        const gateway = createFsGenerationGateway({ enabled, resolve });
        const event = new Proxy({}, { get() { throw new Error('Request must not be read'); } }) as H3Event;
        await expect(gateway.upload(event)).rejects.toMatchObject({ statusCode: 404 });
        await expect(gateway.download(event)).rejects.toMatchObject({ statusCode: 404 });
        await expect(gateway.adapter.presignUpload(event, { workspaceId: 'workspace', hash: identity.hash, sizeBytes: 12, mimeType: 'text/plain' })).rejects.toMatchObject({ statusCode: 404 });
        await expect(gateway.adapter.presignDownload(event, { workspaceId: 'workspace', hash: identity.hash })).rejects.toMatchObject({ statusCode: 404 });
        await expect(gateway.adapter.commit!(event, {})).rejects.toMatchObject({ statusCode: 404 });
        await expect(gateway.recover({ workspaceId: 'workspace', retentionSeconds: 0 })).rejects.toMatchObject({ statusCode: 404 });
        expect(resolve).not.toHaveBeenCalled();
        expect(gateway.adapter).not.toHaveProperty('deletionCoordination');
        expect(gateway.adapter).not.toHaveProperty('externalStorageGenerations');
    });
});

describe('dormant generation transfer credentials', () => {
    it.each(['generation_upload', 'generation_download'] as const)('binds %s to the complete immutable identity and issuing pair', operation => {
        const expiresAt = now() + 60;
        const tokenIdentity = operation === 'generation_upload' ? identity : { ...identity, intentId: undefined, disposition: 'attachment' as const };
        const token = codec().sign(tokenIdentity, operation, expiresAt);
        expect(codec().verify(token, operation)).toMatchObject({
            version: 1, operation, workspaceId: identity.workspaceId, userId: identity.userId,
            generationId: identity.generationId, hash: identity.hash, sizeBytes: identity.sizeBytes, namespaceId,
            storageProviderId: 'fs', syncProviderId: 'sqlite', expiresAt,
        });
        expect(() => codec().verify(token, operation === 'generation_upload' ? 'generation_download' : 'generation_upload')).toThrow();
        if (operation === 'generation_download') expect(codec().verify(token, operation)).not.toHaveProperty('intentId');
    });

    it('rejects protocol downgrade in both directions even with the same signing secret', () => {
        process.env.OR3_STORAGE_FS_TOKEN_SECRET = secret;
        const generation = codec().sign(identity, 'generation_upload', now() + 60);
        expect(() => verifyFsToken(generation)).toThrow();
        const legacy = signFsToken({ op: 'upload', workspace_id: identity.workspaceId,
            user_id: identity.userId, hash: identity.hash, size_bytes: identity.sizeBytes }, 60);
        expect(() => codec().verify(legacy, 'generation_upload')).toThrow();
    });

    it('rejects namespace/provider pair and signature substitution', () => {
        const token = codec().sign(identity, 'generation_upload', now() + 60);
        for (const changed of [{ namespaceId: randomUUID() }, { syncProviderId: 'convex' }, { secret: secret + '-other' }]) {
            const other = createFsGenerationTokenCodec({ secret, namespaceId, syncProviderId: 'sqlite', now, ...changed });
            expect(() => other.verify(token, 'generation_upload')).toThrow();
        }
    });

    it('requires a download policy and rejects uploader intent authority on download credentials', () => {
        expect(() => codec().sign({ ...identity, intentId: undefined }, 'generation_download', now() + 60)).toThrow();
        expect(() => codec().sign({ ...identity, disposition: 'inline' }, 'generation_download', now() + 60)).toThrow();
        expect(() => codec().sign({ ...identity, disposition: 'attachment' }, 'generation_upload', now() + 60)).toThrow();
    });

    it.each([
        { version: 2 }, { op: 'upload' }, { storage_provider_id: 's3' },
        { namespace_id: randomUUID() }, { generation_id: '../path' }, { intent_id: '' },
        { user_id: '' }, { workspace_id: '../workspace' }, { hash: 'md5:' + 'a'.repeat(32) },
        { hash: 'a'.repeat(64) }, { size_bytes: Number.MAX_SAFE_INTEGER + 1 },
        { size_bytes: -1 }, { size_bytes: 0.5 }, { mime_type: 'text/plain\r\nx: y' },
        { exp: 1 }, { iat: now() + 60 }, { exp: now() + 7200 }, { exp: now() + 60.5 },
        { aud: 'legacy' }, { iss: 'legacy' }, { unexpected: 'ambiguous extension' },
    ])('rejects malformed signed claim %j', changed => {
        const valid = jwt.decode(codec().sign(identity, 'generation_upload', now() + 60)) as jwt.JwtPayload;
        const forged = jwt.sign({ ...valid, ...changed }, secret, { algorithm: 'HS256' });
        expect(() => codec().verify(forged, 'generation_upload')).toThrow();
    });

    it('uses the exact bounded intent deadline and rejects expiration without refreshing it', () => {
        let clock = 100;
        const subject = createFsGenerationTokenCodec({ secret, namespaceId, syncProviderId: 'sqlite', now: () => clock });
        expect(() => subject.sign(identity, 'generation_upload', 100)).toThrow();
        expect(() => subject.sign(identity, 'generation_upload', 3701)).toThrow();
        const token = subject.sign(identity, 'generation_upload', 110);
        clock = 110;
        expect(() => subject.verify(token, 'generation_upload')).toThrow();
        expect(() => subject.sign(identity, 'generation_upload', 110)).toThrow();
    });
});

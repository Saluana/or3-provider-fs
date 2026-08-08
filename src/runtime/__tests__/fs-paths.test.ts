/**
 * Unit tests for fs-paths safe path resolution and traversal prevention.
 */
import { describe, it, expect } from 'vitest';
import { getFsObjectMetadataPath, openFsObjectForDownload, resolveFsObjectPath } from '../server/storage/fs-paths';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

describe('fs-paths', () => {
    const ROOT = '/tmp/or3-storage-test';

    it('resolves a sha256 hash path', () => {
        const hash = `sha256:${'a'.repeat(64)}`;
        const path = resolveFsObjectPath(ROOT, 'ws1', hash);
        expect(path).toBe(`${ROOT}/workspaces/ws1/sha256_${'a'.repeat(64)}`);
    });

    it('resolves bare sha256 hex path', () => {
        const hash = 'A'.repeat(64);
        const path = resolveFsObjectPath(ROOT, 'ws1', hash);
        expect(path).toBe(`${ROOT}/workspaces/ws1/sha256_${'a'.repeat(64)}`);
    });

    it('normalizes legacy md5 hashes to md5_<hex>', () => {
        const path = resolveFsObjectPath(ROOT, 'ws1', 'A'.repeat(32));
        expect(path).toBe(`${ROOT}/workspaces/ws1/md5_${'a'.repeat(32)}`);
    });

    it('resolves metadata sidecar path', () => {
        const objectPath = `${ROOT}/workspaces/ws1/sha256_${'a'.repeat(64)}`;
        expect(getFsObjectMetadataPath(objectPath)).toBe(`${objectPath}.meta.json`);
    });

    // Traversal attacks
    it('rejects workspace ID with dots', () => {
        expect(() => resolveFsObjectPath(ROOT, '..', `sha256:${'a'.repeat(64)}`)).toThrow(
            'Invalid workspace ID',
        );
    });

    it('rejects workspace ID with slashes', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws/../etc', `sha256:${'a'.repeat(64)}`)).toThrow(
            'Invalid workspace ID',
        );
    });

    it('rejects malformed hash', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws1', 'sha256:abc')).toThrow('Invalid hash');
    });

    it('rejects unsupported hash algorithm', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws1', `sha1:${'a'.repeat(40)}`)).toThrow('Invalid hash');
    });

    it('rejects workspace ID with spaces', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws 1', `sha256:${'a'.repeat(64)}`)).toThrow(
            'Invalid workspace ID',
        );
    });

    it('rejects empty workspace ID', () => {
        expect(() => resolveFsObjectPath(ROOT, '', `sha256:${'a'.repeat(64)}`)).toThrow(
            'Invalid workspace ID',
        );
    });

    it('rejects empty hash', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws1', '')).toThrow('Invalid hash');
    });

    it('rejects null bytes in workspace ID', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws\0x', `sha256:${'a'.repeat(64)}`)).toThrow(
            'Invalid workspace ID',
        );
    });

    it('rejects special characters in hash', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws1', 'abc;rm -rf')).toThrow('Invalid hash');
    });

    it('rejects a pre-existing symlink that escapes the storage root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'or3-fs-symlink-root-'));
        const outside = await mkdtemp(join(tmpdir(), 'or3-fs-symlink-outside-'));
        const hash = `sha256:${'b'.repeat(64)}`;
        const objectPath = resolveFsObjectPath(root, 'ws1', hash);
        const outsidePath = join(outside, 'secret.txt');

        try {
            await mkdir(dirname(objectPath), { recursive: true });
            await writeFile(outsidePath, 'outside-secret');
            await symlink(outsidePath, objectPath);

            await expect(openFsObjectForDownload(root, objectPath)).rejects.toBeDefined();
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });

    it('rejects a path swapped to an escaping symlink before open', async () => {
        const root = await mkdtemp(join(tmpdir(), 'or3-fs-swap-root-'));
        const outside = await mkdtemp(join(tmpdir(), 'or3-fs-swap-outside-'));
        const hash = `sha256:${'c'.repeat(64)}`;
        const objectPath = resolveFsObjectPath(root, 'ws1', hash);
        const outsidePath = join(outside, 'secret.txt');

        try {
            await mkdir(dirname(objectPath), { recursive: true });
            await writeFile(outsidePath, 'outside-secret');
            await writeFile(objectPath, 'safe-placeholder');
            await rm(objectPath);
            await symlink(outsidePath, objectPath);

            await expect(openFsObjectForDownload(root, objectPath)).rejects.toBeDefined();
            await expect(readFile(outsidePath, 'utf8')).resolves.toBe('outside-secret');
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });
});

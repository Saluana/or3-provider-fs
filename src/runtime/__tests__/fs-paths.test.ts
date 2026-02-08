/**
 * Unit tests for fs-paths safe path resolution and traversal prevention.
 */
import { describe, it, expect } from 'vitest';
import { resolveFsObjectPath } from '../server/storage/fs-paths';

describe('fs-paths', () => {
    const ROOT = '/tmp/or3-storage-test';

    it('resolves a valid path', () => {
        const path = resolveFsObjectPath(ROOT, 'ws1', 'abc123');
        expect(path).toBe(`${ROOT}/workspaces/ws1/abc123`);
    });

    it('resolves with hyphens and underscores', () => {
        const path = resolveFsObjectPath(ROOT, 'my-workspace_1', 'SHA256-hash_v2');
        expect(path).toBe(`${ROOT}/workspaces/my-workspace_1/SHA256-hash_v2`);
    });

    // Traversal attacks
    it('rejects workspace ID with dots', () => {
        expect(() => resolveFsObjectPath(ROOT, '..', 'abc')).toThrow('Invalid workspace ID');
    });

    it('rejects workspace ID with slashes', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws/../etc', 'abc')).toThrow('Invalid workspace ID');
    });

    it('rejects hash with dots', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws1', '../../../etc/passwd')).toThrow('Invalid hash');
    });

    it('rejects hash with slashes', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws1', 'foo/bar')).toThrow('Invalid hash');
    });

    it('rejects workspace ID with spaces', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws 1', 'abc')).toThrow('Invalid workspace ID');
    });

    it('rejects empty workspace ID', () => {
        expect(() => resolveFsObjectPath(ROOT, '', 'abc')).toThrow('Invalid workspace ID');
    });

    it('rejects empty hash', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws1', '')).toThrow('Invalid hash');
    });

    it('rejects null bytes in workspace ID', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws\0x', 'abc')).toThrow('Invalid workspace ID');
    });

    it('rejects special characters in hash', () => {
        expect(() => resolveFsObjectPath(ROOT, 'ws1', 'abc;rm -rf')).toThrow('Invalid hash');
    });
});

# design.md

artifact_id: d441bfb0-5194-44c3-ba8f-d760e234e99c

## Overview

`or3-provider-fs` is a storage-only provider package for OR3 SSR mode.

It registers `StorageGatewayAdapter` (`id: 'fs'`) and serves signed internal upload/download endpoints backed by filesystem storage.

The client transfer queue remains unchanged and continues using `/api/storage/*` gateway endpoints.

## Architecture

```mermaid
flowchart LR
  Client[FileTransferQueue] --> PresignUpload[/api/storage/presign-upload]
  Client --> PresignDownload[/api/storage/presign-download]

  PresignUpload --> Adapter[FsStorageGatewayAdapter]
  PresignDownload --> Adapter

  Adapter --> UploadUrl[/api/storage/fs/upload?token=...]
  Adapter --> DownloadUrl[/api/storage/fs/download?token=...]

  UploadUrl --> FS[(Filesystem Root)]
  DownloadUrl --> FS

  Register[Nitro register.ts] --> StorageRegistry[registerStorageGatewayAdapter('fs')]
```

## Package Layout

```text
or3-provider-fs/
  package.json
  tsconfig.json
  README.md
  src/
    module.ts
    runtime/
      server/
        plugins/
          register.ts
        storage/
          fs-storage-gateway-adapter.ts
          fs-paths.ts
          fs-token.ts
          fs-metadata.ts
        api/storage/fs/
          upload.put.ts
          download.get.ts
```

## Registration

```ts
// src/runtime/server/plugins/register.ts
import { registerStorageGatewayAdapter } from '~~/server/storage/gateway/registry';
import { createFsStorageGatewayAdapter } from '../storage/fs-storage-gateway-adapter';

export default defineNitroPlugin(() => {
  registerStorageGatewayAdapter({
    id: 'fs',
    order: 100,
    create: createFsStorageGatewayAdapter,
  });
});
```

## Nuxt module

```ts
// src/module.ts
import { defineNuxtModule, addServerPlugin, addServerHandler, createResolver } from '@nuxt/kit';

export default defineNuxtModule({
  meta: { name: 'or3-provider-fs' },
  setup() {
    const { resolve } = createResolver(import.meta.url);

    addServerPlugin(resolve('runtime/server/plugins/register'));

    addServerHandler({ route: '/api/storage/fs/upload', method: 'put', handler: resolve('runtime/server/api/storage/fs/upload.put') });
    addServerHandler({ route: '/api/storage/fs/download', method: 'get', handler: resolve('runtime/server/api/storage/fs/download.get') });
  },
});
```

## Token Model

Use signed HMAC token for short-lived operation authorization.

```ts
// src/runtime/server/storage/fs-token.ts
import jwt from 'jsonwebtoken';

export interface FsStorageToken {
  op: 'upload' | 'download';
  workspace_id: string;
  hash: string;
  exp: number;
  size_bytes?: number;
  mime_type?: string;
}

export function signFsToken(payload: Omit<FsStorageToken, 'exp'>, ttlSeconds: number): string {
  const secret = process.env.OR3_STORAGE_FS_TOKEN_SECRET;
  if (!secret) throw new Error('Missing OR3_STORAGE_FS_TOKEN_SECRET');

  return jwt.sign(payload, secret, { expiresIn: ttlSeconds });
}

export function verifyFsToken(token: string): FsStorageToken {
  const secret = process.env.OR3_STORAGE_FS_TOKEN_SECRET;
  if (!secret) throw new Error('Missing OR3_STORAGE_FS_TOKEN_SECRET');

  return jwt.verify(token, secret) as FsStorageToken;
}
```

## Path Safety

```ts
// src/runtime/server/storage/fs-paths.ts
import { resolve, join, normalize } from 'node:path';

export function resolveFsObjectPath(root: string, workspaceId: string, hash: string): string {
  const ws = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = hash.toLowerCase();

  const normalized = normalize(join(root, 'workspaces', ws, file));
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(normalized);

  if (!resolvedPath.startsWith(resolvedRoot + '/')) {
    throw new Error('Invalid storage path');
  }

  return resolvedPath;
}
```

## StorageGatewayAdapter

```ts
// src/runtime/server/storage/fs-storage-gateway-adapter.ts
import type { H3Event } from 'h3';
import type { StorageGatewayAdapter } from '~~/server/storage/gateway/types';
import { signFsToken } from './fs-token';

export class FsStorageGatewayAdapter implements StorageGatewayAdapter {
  id = 'fs';

  async presignUpload(_event: H3Event, input: { workspaceId: string; hash: string; mimeType: string; sizeBytes: number }) {
    const ttl = Number(process.env.OR3_STORAGE_FS_URL_TTL_SECONDS ?? 900);
    const token = signFsToken(
      {
        op: 'upload',
        workspace_id: input.workspaceId,
        hash: input.hash,
        mime_type: input.mimeType,
        size_bytes: input.sizeBytes,
      },
      ttl
    );

    return {
      url: `/api/storage/fs/upload?token=${encodeURIComponent(token)}`,
      method: 'PUT',
      expiresAt: Date.now() + ttl * 1000,
      storageId: `${input.workspaceId}:${input.hash}`,
    };
  }

  async presignDownload(_event: H3Event, input: { workspaceId: string; hash: string }) {
    const ttl = Number(process.env.OR3_STORAGE_FS_URL_TTL_SECONDS ?? 900);
    const token = signFsToken(
      { op: 'download', workspace_id: input.workspaceId, hash: input.hash },
      ttl
    );

    return {
      url: `/api/storage/fs/download?token=${encodeURIComponent(token)}`,
      method: 'GET',
      expiresAt: Date.now() + ttl * 1000,
      storageId: `${input.workspaceId}:${input.hash}`,
    };
  }

  async gc(_event: H3Event, _input: unknown) {
    // v1: implement deletion scan using metadata eligibility criteria.
    return { deleted_count: 0 };
  }
}

export function createFsStorageGatewayAdapter() {
  return new FsStorageGatewayAdapter();
}
```

## Upload Endpoint

```ts
// src/runtime/server/api/storage/fs/upload.put.ts
import { defineEventHandler, getQuery, readRawBody, createError } from 'h3';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { verifyFsToken } from '../../../storage/fs-token';
import { resolveFsObjectPath } from '../../../storage/fs-paths';

export default defineEventHandler(async (event) => {
  const token = String(getQuery(event).token || '');
  if (!token) throw createError({ statusCode: 400, statusMessage: 'Missing token' });

  const claims = verifyFsToken(token);
  if (claims.op !== 'upload') throw createError({ statusCode: 403, statusMessage: 'Invalid operation token' });

  const root = process.env.OR3_STORAGE_FS_ROOT;
  if (!root) throw createError({ statusCode: 500, statusMessage: 'Storage root not configured' });

  const target = resolveFsObjectPath(root, claims.workspace_id, claims.hash);
  const temp = `${target}.tmp-${Date.now()}`;

  const body = await readRawBody(event, false);
  if (!body) throw createError({ statusCode: 400, statusMessage: 'Missing upload body' });

  if (claims.size_bytes && body.length > claims.size_bytes) {
    throw createError({ statusCode: 413, statusMessage: 'Payload too large' });
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(temp, body);
  await rename(temp, target);

  return { ok: true, storage_id: `${claims.workspace_id}:${claims.hash}` };
});
```

Note: intern can replace `readRawBody` with stream piping for large file optimization in v2.

## Download Endpoint

```ts
// src/runtime/server/api/storage/fs/download.get.ts
import { defineEventHandler, getQuery, createError, sendStream } from 'h3';
import { createReadStream, existsSync } from 'node:fs';
import { verifyFsToken } from '../../../storage/fs-token';
import { resolveFsObjectPath } from '../../../storage/fs-paths';

export default defineEventHandler(async (event) => {
  const token = String(getQuery(event).token || '');
  if (!token) throw createError({ statusCode: 400, statusMessage: 'Missing token' });

  const claims = verifyFsToken(token);
  if (claims.op !== 'download') throw createError({ statusCode: 403, statusMessage: 'Invalid operation token' });

  const root = process.env.OR3_STORAGE_FS_ROOT;
  if (!root) throw createError({ statusCode: 500, statusMessage: 'Storage root not configured' });

  const path = resolveFsObjectPath(root, claims.workspace_id, claims.hash);
  if (!existsSync(path)) throw createError({ statusCode: 404, statusMessage: 'File not found' });

  return sendStream(event, createReadStream(path));
});
```

## GC Strategy

v1 implementation:

- use metadata eligibility input from core `gc` request
- delete objects older than retention and unreferenced
- return `{ deleted_count }`

v2 optimization:

- track object manifest or sidecar metadata to avoid expensive scans.

## Error Model

- `400` missing/invalid token
- `403` wrong operation or scope mismatch
- `404` missing file on download
- `413` oversize upload
- `500` server configuration errors

Error messages should remain generic and avoid leaking filesystem paths.

## Testing Strategy

### Unit

- token sign/verify and expiry
- tampered token rejection
- traversal/path escape rejection

### Integration

- presign upload -> upload endpoint -> commit endpoint
- presign download -> download endpoint
- missing/expired token failures
- gc path behavior with mock files

## Intern Implementation Order

1. implement token helper + path helper first
2. implement adapter presign methods
3. implement upload/download endpoints
4. wire register plugin and module
5. run integration tests with transfer queue flow
6. implement GC and retention behavior

## Reference Notes

For Nitro storage patterns and local storage strategy:

- https://nitro.build/guide/storage
- https://vueschool.io/articles/vuejs-tutorials/handling-file-uploads-in-nuxt-with-usestorage/


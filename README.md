# or3-provider-fs

Filesystem storage provider for [OR3 Chat](https://github.com/or3-chat/or3-chat) — local-disk blob storage via signed tokens.

## What It Does

Registers a `StorageGatewayAdapter` (ID: `fs`) that stores uploaded files on the local filesystem. The existing client `FileTransferQueue` works unchanged — presign endpoints return signed internal URLs that the upload/download handlers verify.

**This is a storage-only provider.** It does not provide auth or sync. Pair it with `or3-provider-basic-auth` + `or3-provider-sqlite` (or Clerk + Convex) for a complete stack.

## Install

```bash
bun add or3-provider-fs
```

Add to `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  modules: [
    'or3-provider-fs/nuxt',
    // ... other providers
  ],
});
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OR3_STORAGE_FS_ROOT` | **Yes** | — | Absolute path to the storage root directory |
| `OR3_STORAGE_FS_TOKEN_SECRET` | **Yes** | — | HMAC secret for signing presign tokens (≥32 chars recommended) |
| `OR3_STORAGE_FS_URL_TTL_SECONDS` | No | `900` | Token / presigned URL lifetime in seconds |

## How It Works

```
Client (FileTransferQueue)
  │
  ├─ POST /api/storage/presign-upload   ──► FsStorageGatewayAdapter.presignUpload()
  │   returns signed URL:                     signs JWT with op/ws/hash/size/mime
  │   /api/storage/fs/upload?token=...
  │
  ├─ PUT  /api/storage/fs/upload?token=...  ──► upload.put.ts
  │   verifies token, atomic write              temp file → rename
  │   returns { ok, storage_id }
  │
  ├─ POST /api/storage/presign-download  ──► FsStorageGatewayAdapter.presignDownload()
  │   returns signed URL:                     signs JWT with op/ws/hash
  │   /api/storage/fs/download?token=...
  │
  └─ GET  /api/storage/fs/download?token=... ──► download.get.ts
      verifies token, streams file               createReadStream → sendStream
```

### File Layout on Disk

```
$OR3_STORAGE_FS_ROOT/
  workspaces/
    <workspaceId>/
      <hash>          ← content-addressed blob
```

### Security

- **Path traversal prevention**: workspace IDs and hashes are validated against `[a-zA-Z0-9_-]+` and resolved paths are checked to stay under the storage root.
- **Short-lived tokens**: presigned URLs expire after `OR3_STORAGE_FS_URL_TTL_SECONDS` (default 15 min).
- **Operation scope**: upload tokens can't be used for download and vice versa.
- **Atomic writes**: files are written to a temp path first, then renamed to prevent partial-upload corruption.

## Backup

The storage root is a plain directory tree. Back it up with any tool:

```bash
rsync -a "$OR3_STORAGE_FS_ROOT" /backup/or3-storage/
```

## Development

```bash
bun run test        # Run tests (29 tests)
bun run type-check  # TypeScript check
bun run build       # Build nuxt module
```

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `Missing OR3_STORAGE_FS_TOKEN_SECRET` | Env var not set | Set a strong secret (≥32 chars) |
| `Storage root not configured` | `OR3_STORAGE_FS_ROOT` missing | Set to an absolute path |
| `EACCES` / permission denied | Process can't write to root | `chmod`/`chown` the storage directory |
| `Invalid or expired token` | Token expired or tampered | Client should re-presign; check clocks |
| `Payload too large` (413) | Upload body exceeds `size_bytes` claim | Check file size before upload |

## v2 TODOs

- [ ] Replace `readRawBody` with stream piping for large file uploads
- [ ] Implement real GC scan using ref metadata from sync layer
- [ ] Add `Content-Type` header on downloads from stored mime metadata
- [ ] Sidecar metadata files to avoid directory scans during GC

## Compatibility

Works with any auth/sync provider combo. Tested against `or3-provider-basic-auth` + `or3-provider-sqlite` and `or3-provider-clerk` + `or3-provider-convex` stacks.

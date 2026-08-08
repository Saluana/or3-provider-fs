# or3-provider-fs

Filesystem storage provider for [OR3 Chat](https://github.com/or3-chat/or3-chat) — local-disk blob storage via signed tokens.

## What It Does

Registers a `StorageGatewayAdapter` (ID: `fs`) that stores uploaded files on the local filesystem. The existing client `FileTransferQueue` works unchanged — presign endpoints return signed internal URLs that the upload/download handlers verify.

**This is a storage-only provider.** It does not provide auth or sync. Pair it with `or3-provider-basic-auth` + `or3-provider-sqlite` (or Clerk + Convex) for a complete stack.

The adapter only registers when auth and storage are enabled and `fs` is the active storage provider (e.g. `SSR_AUTH_ENABLED=true`, `OR3_STORAGE_ENABLED=true`, `NUXT_PUBLIC_STORAGE_PROVIDER=fs`). Otherwise registration is skipped with a startup warning.

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
| `OR3_STORAGE_FS_URL_TTL_SECONDS` | No | `900` | Token / presigned URL lifetime in seconds (maximum 3600) |
| `OR3_STRICT_CONFIG` | No | — | Accepted for compatibility with host config. Fs config validation is fail-fast whenever the fs provider is active — missing `OR3_STORAGE_FS_ROOT` / `OR3_STORAGE_FS_TOKEN_SECRET` abort startup in any mode |

## How It Works

```
Client (FileTransferQueue)
  │
  ├─ POST /api/storage/presign-upload   ──► FsStorageGatewayAdapter.presignUpload()
  │   returns signed URL:                     signs JWT with op/ws/hash/size/mime
  │   /api/storage/fs/upload?token=...
  │
  ├─ PUT  /api/storage/fs/upload?token=...  ──► upload.put.ts
  │   verifies token + hash digest, atomic     temp file → rename
  │   write                                    returns { ok, storage_id }
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
      sha256_<hex>      ← content-addressed blob (md5_<hex> for md5: hashes)
      sha256_<hex>.meta.json  ← upload commit sidecar
```

### Security

- **Path traversal prevention**: workspace IDs are validated against `[a-zA-Z0-9_-]+`; hashes must be canonical `sha256:<hex>` or `md5:<hex>` forms and are normalized to safe file keys.
- **Short-lived tokens**: presigned URLs expire after `OR3_STORAGE_FS_URL_TTL_SECONDS` (default 15 min, maximum 1 hour).
- **Operation scope**: upload tokens can't be used for download and vice versa.
- **User scope**: upload/download tokens are bound to the authenticated user and workspace checks.
- **Atomic writes**: files are written to a temp path first, then renamed to prevent partial-upload corruption.
- **Integrity checks**: uploads are size-capped by the token's `size_bytes` claim (413) and the stream is verified against the claimed hash before rename (400 `Hash mismatch`).
- **MIME enforcement**: when the token carries a `mime_type` claim, the upload `Content-Type` must match it (415).
- **Symlink-safe downloads**: downloads resolve the real path and open with `O_NOFOLLOW`, rejecting anything that escapes the storage root.

## Backup

The storage root is a plain directory tree. Back it up with any tool:

```bash
rsync -a "$OR3_STORAGE_FS_ROOT" /backup/or3-storage/
```

Committed blobs create `.meta.json` sidecars. Include those files in backups.

## Garbage Collection Safety

Filesystem blob GC uses bounded canonical queries (`live_metadata`, `reference_edges`)
against materialized `file_meta` and live message/post reference edges, then rechecks
immediately before deleting a retained blob and its sidecar. It never reconstructs
liveness from sync history. When the active sync provider does not expose canonical
storage queries, GC fails closed with `{ deleted_count: 0, status: "disabled",
reason: "canonical_reference_state_required" }` and deletes nothing.

GC runs per workspace via the provider admin action `storage.gc` (default retention
30 days, `retentionDays`/`retentionSeconds` and `limit` accepted in the action payload).

## Development

```bash
bun run test        # Run tests
bun run lint        # ESLint
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
| `Invalid operation token` (403) | Upload token used for download (or vice versa) | Re-presign with the correct operation |
| `Payload too large` (413) | Upload body exceeds `size_bytes` claim | Check file size before upload |
| `Hash mismatch` (400) | Uploaded bytes don't match the claimed hash | Re-hash the file and re-presign |
| `Content type mismatch` (415) | Upload `Content-Type` differs from the token's `mime_type` | Send the declared `Content-Type` |
| `Storage root must be absolute` | `OR3_STORAGE_FS_ROOT` is a relative path | Set an absolute path |

## v2 TODOs

- [x] Set `Content-Type` on downloads from the token's mime claim (done — with `application/octet-stream` fallback)
- [ ] Use `.meta.json` sidecars to avoid directory scans during GC (sidecars are now written on commit and removed on delete, but GC still enumerates the workspace directory)

## Compatibility

Works with any auth/sync provider combo. Tested against `or3-provider-basic-auth` + `or3-provider-sqlite` and `or3-provider-clerk` + `or3-provider-convex` stacks.

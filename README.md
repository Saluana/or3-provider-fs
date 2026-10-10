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
- **Committed downloads**: the host endpoint requires live canonical workspace metadata; this adapter additionally requires both the blob and its `.meta.json` commit sidecar. Pending or soft-deleted files return not found.
- **Atomic writes**: files are written to a temp path first, then renamed to prevent partial-upload corruption.
- **Integrity checks**: uploads are size-capped by the token's `size_bytes` claim (413) and the stream is verified against the claimed hash before rename (400 `Hash mismatch`).
- **Empty files**: a zero-byte upload is valid when its token claims size `0` and the empty-body hash.
- **MIME enforcement**: when the token carries a `mime_type` claim, the upload `Content-Type` must match it (415).
- **Safe downloads**: generic or active content is returned as an `application/octet-stream` attachment with `X-Content-Type-Options: nosniff`; only supported raster images and PDFs may remain inline.
- **Symlink-safe downloads**: downloads resolve the real path and open with `O_NOFOLLOW`, rejecting anything that escapes the storage root.

## Backup

The storage root is a plain directory tree. Back it up with any tool:

```bash
rsync -a "$OR3_STORAGE_FS_ROOT" /backup/or3-storage/
```

Committed blobs create `.meta.json` sidecars. Include those files in backups.

## Deletion and Garbage Collection Safety

Physical deletion is disabled until a provider-owned protocol can coordinate
filesystem unlink with canonical sync writes. Existing blobs or commit sidecars
return HTTP 503; an already absent object is an idempotent success. GC returns
`{ deleted_count: 0, status: "disabled", reason: "deletion_coordination_required" }`
without deleting bytes or querying canonical state. Logical Trash/removal retains
the original bytes. Independent canonical scans cannot prevent a concurrent
restore or reference write.

GC runs per workspace via the provider admin action `storage.gc` (default retention
30 days, `retentionDays`/`retentionSeconds` and `limit` accepted in the action payload).

### Read-only storage usage

The workspace-scoped provider admin action `storage.usage` returns a bounded,
non-atomic observation. Optional `maxEntries` and `maxMetadataRecords` limits
default to 10,000 and accept integers from 1 through 50,000.

Canonical active metadata, retained deleted metadata and upload reservations
are separate from observed active blobs, retained blobs, incomplete transfers,
sidecars and unclassified bytes. Unknown or failed canonical views are null,
not zero. Filesystem counts are partial when `filesystem.complete` is false;
check warnings before using them. Unsupported safe directory descriptor views
also report an incomplete filesystem observation.

Apparent bytes count observed file names. Allocated bytes count unique observed
inodes using filesystem block statistics, so hard links are deduplicated within
this scan; they do not establish exclusive ownership or reclaimable bytes.
Volume totals describe the entire backing filesystem, not workspace quota.
Neither these observations nor retained metadata authorize physical cleanup.

## Development

```bash
bun run test        # Run tests
bun run lint        # ESLint
bun run type-check  # TypeScript check
bun run build       # Build nuxt module
```

After changing imports from the OR3 Chat host, regenerate the release-only
`src/shims/or3-chat-contract.ts` fixture with `bun run provider-host-contracts`
from the sibling `or3-chat` checkout. CI compares the committed fixture with the
generator from its pinned host revision before qualification and publication.

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
- [ ] Add durable cross-backend deletion coordination before enabling physical cleanup. Commit sidecars and read-only accounting alone do not make deletion safe.

## Compatibility

Works with any auth/sync provider combo. Tested against `or3-provider-basic-auth` + `or3-provider-sqlite` and `or3-provider-clerk` + `or3-provider-convex` stacks.


### Testing local changes in OR3 Chat

With this repository beside `or3-chat`, run `bun install` here once, then
`bun run dev:ssr` from Chat. Chat's dev wrapper rebuilds the local provider and
prints its selected path; restart it after provider edits. Missing repositories
or failed builds fall back to installed packages with a warning.
`OR3_LOCAL_PROVIDERS=false` disables local selection. Production builds use the
installed package, so local development does not publish these changes.

## Physical deletion coordination

Filesystem unlink and GC fail closed until a cross-backend deletion claim protocol exists. Independent canonical scans cannot prevent a restore/reference race. Existing physical objects return 503 from delete; GC reports disabled with `deletion_coordination_required`. Logical Files Trash/removal retains the bytes.

## Hash format mismatch makes real uploads fail

Location: `src/runtime/server/storage/fs-paths.ts:10-26` and `/Users/brendon/Documents/or3/or3-chat/app/utils/hash.ts:8-9`

`resolveFsObjectPath` only accepts `[a-zA-Z0-9_-]+` for `hash`, but OR3 produces hashes like `sha256:<hex>`. The colon is mandatory in the core format, so this provider rejects legitimate hashes.

Consequence: presign succeeds, but upload/download handlers reject path resolution with `Invalid path parameters` for real client data. Storage provider is effectively broken in normal OR3 flows.

Fix: normalize hash before pathing (parse `sha256:<hex>` and store only hex) or explicitly support canonical prefixed hash format in validation.

## Uploaded bytes are never verified against claimed hash

Location: `src/runtime/server/api/storage/fs/upload.put.ts:39-58`

The handler trusts the token hash and writes raw bytes directly. There is no server-side digest check that uploaded content matches `claims.hash`.

Consequence: a client can upload arbitrary bytes under any claimed hash, poisoning content-addressed storage. Downloads then fail integrity checks client-side, causing persistent broken attachments and potential workspace-level DoS.

Fix: compute digest on upload (`sha256`/`md5` based on hash prefix) and reject mismatches before final rename.

## Bearer token endpoints are not bound to user/session

Location: `src/runtime/server/api/storage/fs/upload.put.ts:14-58` and `src/runtime/server/api/storage/fs/download.get.ts:13-45`

Internal endpoints only verify token signature and op. They do not verify current session identity, workspace membership, or user binding at request time.

Consequence: leaked presigned URLs are fully replayable by anyone until expiry, regardless of auth state. This is especially bad for download URLs in logs, browser history, or referrers.

Fix: include session/user claim in token and verify against current session, or require authenticated context and workspace check on these endpoints.

## GC is a no-op stub dressed up as finished work

Location: `src/runtime/server/storage/fs-storage-gateway-adapter.ts:66-69` and `planning/tasks.md:87-94`

`gc()` always returns `{ deleted_count: 0 }`, while planning docs claim GC eligibility and deletion are implemented.

Consequence: operators think retention works, but disk usage grows forever and orphaned blobs never get cleaned up.

Fix: implement real GC scan using `workspace_id`, `retention_seconds`, and reference metadata; only keep stub if docs and task list explicitly mark it incomplete.

## Startup config validation is missing

Location: `src/runtime/server/plugins/register.ts:7-17` and `planning/requirements.md:33-37`

The plugin registers adapter with no validation for `OR3_STORAGE_FS_ROOT` or `OR3_STORAGE_FS_TOKEN_SECRET`, despite requirements calling for strict startup failure and non-strict warnings.

Consequence: broken config is detected only at request time (500/403), which is late, noisy, and operationally sloppy.

Fix: validate env in plugin init, fail fast in strict mode, warn-and-disable in non-strict mode.

## TTL parsing is unsafe and can produce invalid expiry behavior

Location: `src/runtime/server/storage/fs-storage-gateway-adapter.ts:24-25` and `src/runtime/server/storage/fs-storage-gateway-adapter.ts:48-49`

TTL uses `Number(process.env.OR3_STORAGE_FS_URL_TTL_SECONDS ?? 900)` without bounds checks. `NaN`, `0`, negatives, and absurdly large values are not handled.

Consequence: token signing may throw, `expiresAt` can be `NaN`, and clients receive unusable or instantly-expired URLs.

Fix: parse int with strict validation (`Number.isInteger && > 0 && <= max`), fallback to default when invalid.

## Upload path is full-buffered despite explicit streaming requirement

Location: `src/runtime/server/api/storage/fs/upload.put.ts:39` and `planning/requirements.md:61-63`

The handler uses `readRawBody`, which buffers the entire upload in memory before writing to disk.

Consequence: memory usage scales with file size and concurrent uploads, causing avoidable latency spikes and potential OOM on small servers.

Fix: stream request body to temp file (`pipeline` / writable stream), enforce size limit incrementally, then atomic rename.

## Critical tests are fake and miss real regressions

Location: `src/runtime/__tests__/fs-token.test.ts:47-73` and `src/runtime/__tests__/fs-storage.test.ts:119-151`

The “expired token” test never asserts expiry failure. The “integration” flow never calls upload/download handlers; it manually writes/reads files. These tests bypass the actual risk surface.

Consequence: test suite shows green while critical behavior is broken (hash-format mismatch, auth/token edge cases, endpoint error paths).

Fix: add endpoint-level tests hitting handlers directly with realistic `sha256:<hex>` hashes, expired tokens, and malformed claims.

## MIME constraints are asserted in comments but not enforced in upload handler

Location: `src/runtime/server/api/storage/fs/upload.put.ts:42-44` and `src/runtime/server/storage/fs-token.ts:10-16`

Token carries `mime_type`, but upload endpoint ignores it. The only enforced claim is optional size.

Consequence: clients can presign as allowed MIME, upload different content type, and bypass intent-level content policy at storage edge.

Fix: validate request `Content-Type` against token claim (or normalize and compare), reject mismatches with 415.

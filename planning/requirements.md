# requirements.md

artifact_id: 5dfe266f-6189-48b9-b8c3-295f3887b433

## Overview

Build `or3-provider-fs` as a storage-only provider package that implements OR3 gateway storage on local filesystem.

Scope is limited to storage provider concerns:

- `StorageGatewayAdapter` registration with ID `fs`
- secure presign/token workflow for internal upload/download endpoints
- filesystem write/read/GC behavior compatible with existing transfer queue

This provider does not implement auth provider logic or sync provider logic.

## Roles

- End User: uploads and downloads attachments through existing local-first queue.
- Instance Operator: configures storage root and token secret.
- OR3 Maintainer: ensures safe filesystem behavior and compatibility with core storage contracts.

## Requirements

### 1. Package and Registration

1.1 As a Maintainer, I want `or3-provider-fs` installable as a Nuxt module, so that storage can be selected by config.

- Package SHALL expose `or3-provider-fs/nuxt`.
- Module SHALL register `StorageGatewayAdapter` with ID `fs`.
- Provider SHALL not import Convex SDKs.

1.2 As an Operator, I want clear startup behavior, so that misconfiguration is obvious.

- Missing required env vars (`OR3_STORAGE_FS_ROOT`, token secret) in strict mode SHALL fail startup with actionable errors.
- Non-strict mode SHALL warn clearly.

### 2. Presign and Token Workflow

2.1 As a User, I want upload/download to continue using current queue behavior, so that UI and local-first workflow remain unchanged.

- `presignUpload` SHALL return URL/method compatible with `FileTransferQueue`.
- `presignDownload` SHALL return URL/method compatible with `FileTransferQueue`.
- Provider SHALL return a stable `storage_id` for commit flow compatibility.

2.2 As a Security Reviewer, I want signed short-lived operation tokens, so that URLs cannot be reused indefinitely.

- Upload/download URLs SHALL include signed token with scope and expiry.
- Token payload SHALL include workspace ID, hash, operation type, and expiry.
- Expired or tampered tokens SHALL be rejected.

### 3. Filesystem Safety

3.1 As a Security Reviewer, I want path traversal protections, so that files cannot be written/read outside storage root.

- Provider SHALL normalize and validate resolved file paths under configured root.
- Hash/path input SHALL be validated against expected format.

3.2 As an Operator, I want reliable writes, so that partial uploads don’t corrupt storage.

- Upload handler SHALL use atomic write strategy (temp file then rename).
- Large file handling SHALL stream data rather than loading full file into memory on server.

3.3 As a User, I want predictable download behavior, so that existing attachments are retrievable.

- Download handler SHALL return 404 for missing files.
- Download handler SHALL stream file bytes with correct content type where available.

### 4. Authorization and Access Control

4.1 As a Security Reviewer, I want access checks to remain centralized, so that authorization policy stays consistent.

- Adapter-facing presign endpoints SHALL continue to use existing `can()` checks in core routes.
- Internal upload/download endpoints SHALL enforce token scope and session/workspace consistency.

4.2 As a Maintainer, I want no auth leakage, so that storage endpoints are not usable across workspaces.

- Token workspace ID mismatch SHALL reject request.
- Hash mismatch SHALL reject request.

### 5. GC and Retention

5.1 As an Operator, I want stale file cleanup, so that disk usage remains bounded.

- Adapter `gc` SHALL remove files eligible under retention and metadata rules.
- Active referenced files SHALL not be deleted.

5.2 As a Maintainer, I want compatibility with existing file metadata semantics, so that sync/storage contract remains stable.

- `ref_count` SHALL remain derived behavior (not authoritative synced LWW state).
- GC decisions SHALL align with existing metadata expectations.

### 6. Performance and Reliability

6.1 As an Operator, I want efficient IO behavior, so that storage operations scale on small servers.

- Provider SHALL prefer streamed IO for upload/download.
- Provider SHALL avoid full directory scans on hot-path requests.

6.2 As a Maintainer, I want deterministic adapter behavior, so that retries in transfer queue are predictable.

- Upload/download failures SHALL return clear status codes for retry policy.
- Non-retryable validation failures SHALL return stable client-visible errors.

### 7. Testing

7.1 As a Maintainer, I want unit tests for token and path safety, so that security regressions are caught early.

- Unit tests SHALL cover token signing/verification, expiry, tampering, path traversal rejection.

7.2 As a Maintainer, I want integration tests for end-to-end storage flow, so that provider wiring is validated.

- Integration tests SHALL cover presign-upload, upload, commit, presign-download, download.
- Integration tests SHALL cover GC behavior under retention constraints.

### 8. Documentation

8.1 As an Operator, I want a provider-specific setup guide, so that installation and runtime config are clear.

- Docs SHALL include install steps, env vars, storage root permissions, and backup advice.

8.2 As an Intern, I want implementation examples with endpoint flow, so that execution is straightforward.

- Design doc SHALL include file layout and handler snippets.


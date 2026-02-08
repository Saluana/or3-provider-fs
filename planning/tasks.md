# tasks.md

artifact_id: afbe6453-22c3-4568-ad4e-cc92e2d17d5c

## 0. Preflight

- [x] Initialize package metadata and Bun scripts
  - Requirements: 1.1
- [x] Define env contract for storage root, token secret, URL TTL
  - Requirements: 1.2
- [x] Add README skeleton with install/setup sections
  - Requirements: 8.1

## 1. Package Scaffolding

- [x] Create `src/module.ts` Nuxt module entry
  - Requirements: 1.1
- [x] Create runtime folders (`server/plugins`, `server/storage`, `server/api/storage/fs`)
  - Requirements: 1.1
- [x] Configure TypeScript build/test setup
  - Requirements: 1.1

## 2. Core Storage Helpers

### 2.1 Token helper

- [x] Implement sign/verify helper for fs operation tokens
  - Requirements: 2.2, 7.1
- [x] Include op/workspace/hash/expiry claims and optional size/mime
  - Requirements: 2.2
- [x] Add explicit token validation errors
  - Requirements: 4.2

### 2.2 Path helper

- [x] Implement root-resolved object path helper
  - Requirements: 3.1
- [x] Enforce normalization and traversal prevention
  - Requirements: 3.1
- [x] Validate hash and workspace inputs
  - Requirements: 3.1, 4.2

## 3. StorageGatewayAdapter

- [x] Implement `FsStorageGatewayAdapter` class
  - Requirements: 1.1, 2.1
- [x] Implement `presignUpload`
  - Requirements: 2.1, 2.2
- [x] Implement `presignDownload`
  - Requirements: 2.1, 2.2
- [x] Return compatible `storageId` shape for commit flow
  - Requirements: 2.1
- [x] Add optional `gc` method stub with retention input handling
  - Requirements: 5.1

## 4. Endpoint Implementation

### 4.1 Upload endpoint

- [x] Parse and verify upload token
  - Requirements: 2.2, 4.2
- [x] Validate payload size/mime constraints from token claims
  - Requirements: 3.2, 4.2
- [x] Implement atomic write (temp + rename)
  - Requirements: 3.2
- [x] Return `{ ok, storage_id }` response for queue compatibility
  - Requirements: 2.1

### 4.2 Download endpoint

- [x] Parse and verify download token
  - Requirements: 2.2, 4.2
- [x] Resolve safe filesystem path and existence check
  - Requirements: 3.1, 3.3
- [x] Stream file to response
  - Requirements: 3.3, 6.1

## 5. Registration and Wiring

- [x] Implement Nitro registration plugin for adapter ID `fs`
  - Requirements: 1.1
- [x] Register upload/download handlers in module setup
  - Requirements: 1.1
- [x] Verify provider selected by `NUXT_PUBLIC_STORAGE_PROVIDER=fs`
  - Requirements: 1.1, 1.2

## 6. GC and Retention

- [x] Implement GC eligibility logic based on retention input
  - Requirements: 5.1
- [x] Ensure referenced files are not deleted
  - Requirements: 5.1, 5.2
- [x] Return stable gc summary payload
  - Requirements: 5.1

## 7. Testing

### 7.1 Unit

- [x] Token sign/verify tests
  - Requirements: 7.1
- [x] Token expiry/tamper tests
  - Requirements: 7.1
- [x] Path traversal rejection tests
  - Requirements: 7.1

### 7.2 Integration

- [x] Presign-upload -> upload -> commit path test
  - Requirements: 7.2
- [x] Presign-download -> download path test
  - Requirements: 7.2
- [x] Missing/invalid token endpoint tests
  - Requirements: 4.2, 7.2
- [x] GC integration test with staged files
  - Requirements: 5.1, 7.2

### 7.3 Package validation

- [x] Run `bun run type-check`
  - Requirements: 7.2
- [x] Run `bun run test`
  - Requirements: 7.2
- [x] Run `bun run build`
  - Requirements: 7.2

## 8. Documentation and Handoff

- [x] Finalize README with env vars and deployment notes
  - Requirements: 8.1
- [x] Add troubleshooting for common failures (permission denied, missing root, invalid token)
  - Requirements: 8.1
- [x] Add intern quickstart sequence and TODOs for v2 streaming optimizations
  - Requirements: 8.2


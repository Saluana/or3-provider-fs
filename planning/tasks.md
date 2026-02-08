# tasks.md

artifact_id: afbe6453-22c3-4568-ad4e-cc92e2d17d5c

## 0. Preflight

- [ ] Initialize package metadata and Bun scripts
  - Requirements: 1.1
- [ ] Define env contract for storage root, token secret, URL TTL
  - Requirements: 1.2
- [ ] Add README skeleton with install/setup sections
  - Requirements: 8.1

## 1. Package Scaffolding

- [ ] Create `src/module.ts` Nuxt module entry
  - Requirements: 1.1
- [ ] Create runtime folders (`server/plugins`, `server/storage`, `server/api/storage/fs`)
  - Requirements: 1.1
- [ ] Configure TypeScript build/test setup
  - Requirements: 1.1

## 2. Core Storage Helpers

### 2.1 Token helper

- [ ] Implement sign/verify helper for fs operation tokens
  - Requirements: 2.2, 7.1
- [ ] Include op/workspace/hash/expiry claims and optional size/mime
  - Requirements: 2.2
- [ ] Add explicit token validation errors
  - Requirements: 4.2

### 2.2 Path helper

- [ ] Implement root-resolved object path helper
  - Requirements: 3.1
- [ ] Enforce normalization and traversal prevention
  - Requirements: 3.1
- [ ] Validate hash and workspace inputs
  - Requirements: 3.1, 4.2

## 3. StorageGatewayAdapter

- [ ] Implement `FsStorageGatewayAdapter` class
  - Requirements: 1.1, 2.1
- [ ] Implement `presignUpload`
  - Requirements: 2.1, 2.2
- [ ] Implement `presignDownload`
  - Requirements: 2.1, 2.2
- [ ] Return compatible `storageId` shape for commit flow
  - Requirements: 2.1
- [ ] Add optional `gc` method stub with retention input handling
  - Requirements: 5.1

## 4. Endpoint Implementation

### 4.1 Upload endpoint

- [ ] Parse and verify upload token
  - Requirements: 2.2, 4.2
- [ ] Validate payload size/mime constraints from token claims
  - Requirements: 3.2, 4.2
- [ ] Implement atomic write (temp + rename)
  - Requirements: 3.2
- [ ] Return `{ ok, storage_id }` response for queue compatibility
  - Requirements: 2.1

### 4.2 Download endpoint

- [ ] Parse and verify download token
  - Requirements: 2.2, 4.2
- [ ] Resolve safe filesystem path and existence check
  - Requirements: 3.1, 3.3
- [ ] Stream file to response
  - Requirements: 3.3, 6.1

## 5. Registration and Wiring

- [ ] Implement Nitro registration plugin for adapter ID `fs`
  - Requirements: 1.1
- [ ] Register upload/download handlers in module setup
  - Requirements: 1.1
- [ ] Verify provider selected by `NUXT_PUBLIC_STORAGE_PROVIDER=fs`
  - Requirements: 1.1, 1.2

## 6. GC and Retention

- [ ] Implement GC eligibility logic based on retention input
  - Requirements: 5.1
- [ ] Ensure referenced files are not deleted
  - Requirements: 5.1, 5.2
- [ ] Return stable gc summary payload
  - Requirements: 5.1

## 7. Testing

### 7.1 Unit

- [ ] Token sign/verify tests
  - Requirements: 7.1
- [ ] Token expiry/tamper tests
  - Requirements: 7.1
- [ ] Path traversal rejection tests
  - Requirements: 7.1

### 7.2 Integration

- [ ] Presign-upload -> upload -> commit path test
  - Requirements: 7.2
- [ ] Presign-download -> download path test
  - Requirements: 7.2
- [ ] Missing/invalid token endpoint tests
  - Requirements: 4.2, 7.2
- [ ] GC integration test with staged files
  - Requirements: 5.1, 7.2

### 7.3 Package validation

- [ ] Run `bun run type-check`
  - Requirements: 7.2
- [ ] Run `bun run test`
  - Requirements: 7.2
- [ ] Run `bun run build`
  - Requirements: 7.2

## 8. Documentation and Handoff

- [ ] Finalize README with env vars and deployment notes
  - Requirements: 8.1
- [ ] Add troubleshooting for common failures (permission denied, missing root, invalid token)
  - Requirements: 8.1
- [ ] Add intern quickstart sequence and TODOs for v2 streaming optimizations
  - Requirements: 8.2


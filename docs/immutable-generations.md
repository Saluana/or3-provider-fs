# Dormant immutable-generation filesystem protocol

`fs-generations.ts` is an internal primitive used only by explicitly constructed,
default-disabled factories and tests. No registered route, adapter, registry,
cleanup job, or capability flag selects it. Production deletion remains
disabled. Existing content-hash paths are legacy, unmanaged, and never selected.

## Namespace and publication

An explicitly provisioned, UUID-bound namespace contains permanent generation
slots: `generations-v1/workspaces/<workspace>/<generation UUID>/`. A slot holds a
permanent `ready.json` manifest and a removable `payload/` directory. The manifest
binds workspace, generation, SHA-256, size, namespace, storage ID, and payload
device/inode. Namespace and generation IDs must be fresh UUIDv4 identities.
New manifests also contain a random readiness receipt UUID created only by the
exclusive allocator. Earlier manifests are never silently adopted or repaired
by upload recovery; a missing receipt makes their readiness unknown.

Only the successful exclusive slot creator can create `payload`. Existing-slot
retries never repair or recreate it. A crash before the ready manifest leaves an
incomplete, retained slot. No publication receipt or deletion acknowledgement is
issued for it. A creator paused before initialization cannot race a valid claim:
there is no ready payload, verified receipt, or registered canonical generation.

Publication opens descriptor-pinned directories without following symlinks,
writes an exclusive temporary file, verifies exact streamed size and SHA-256,
fsyncs it, and hard-links it to `blob` without overwriting an existing target.
The temporary alias is unlinked and the final file is independently verified.
Validated manifests, the blob, and all opened namespace directories are synced
before returning a receipt, even if the original allocator has not returned.
The final named payload must still match its pinned identity. Duplicate uploads
replay the same inode; a concurrent transient extra link may cause a safe refusal
that can be retried. Receipts are trusted-server results, never client assertions.

## Claim-bound removal

Removal requires the version-1 coordinator paired to provider ID `fs`. Its
authorization read must itself validate durable canonical state, storage guards,
and absence of an outer transaction. The matching claim is irreversible and
binds exact workspace, SHA-256, generation, namespace-bearing storage ID and size.
Claimed or already-deleted records permit only an idempotent retry of that claim.

Removal enumerates only the verified pinned payload, with an explicit entry
budget. Unknown entries, symlinks, external hardlinks, incomplete scans, I/O
errors, or a changed payload identity leave the operation pending/refused. Internal
temporary/blob hardlink aliases from an interrupted publisher can be removed.
After unlinking known files, removal must remove the exact payload directory and
fsync the permanent slot. A delayed writer adding an entry causes `rmdir` to fail
and leaves the claim pending. Once `rmdir` succeeds, writers with old directory
descriptors cannot add entries, and allocation retries cannot recreate payload.

The primitive never calls canonical `completeDeletion`. A trusted coordinator
may acknowledge completion only after `removed` or `already_absent` (which also
syncs the slot). `pending`, exceptions, missing namespace/slot/manifest, and
uncertain durability never qualify. It is safe to retry after process death
between claim, unlink, rmdir, directory fsync, and canonical acknowledgement.
Permanent slot/manifest tombstones are never removed. Open unlinked files may
still consume blocks; no result claims a reclaimed-byte total.

## Test-only composition

The explicit integration lane uses the real SQLite provider, its full migrations
and SQL guards, file-backed WAL/FULL databases, real files and separate Bun
processes. It publishes bytes first, then calls trusted
`registerVerifiedGeneration`. Unregistered slots are unclaimable. While a
successor is uploading, the old head remains claimed and refuses new references;
registration installs the new verified head. Replaying registration of an old
generation returns its irreversible state, which callers must check rather than
treating `replayed` as proof that it is live.

With the reviewed SQLite source and installed dependencies in sibling `../sqlite`
and the matching prepared host in `../or3-chat`, run:

```sh
bun --bun run test
bun --bun run test:generations:sqlite
bun --bun run type-check
bun --bun run type-check:standalone
bun --bun run type-check:generations
bun --bun run lint
bun --bun run build
```

The mandatory CI lane pins host
`d9449167416bb3be41169706898b8741d23bb3ad` and SQLite
`5e3ca937b51f107ed63a8e0c099501b51f30a5fb`. Both remote trees were verified to match
the locally qualified dependencies. Changing the pair requires rerunning this lane.

The integration command fails if its sibling dependency is absent; it does not
silently skip. It proves conditional unlink, restore/new-reference refusal,
same-hash successor safety, two-collector replay, delayed publication, pending
directory removal, and SIGKILL/reopen retries. Primitive tests also exercise
allocation crashes, duplicate publishers, internal/external hardlinks, bounded
scans and symlink/path substitution. No mock filesystem is used. SIGKILL tests
exercise process-crash recovery, not simulated kernel/power loss; durability
depends on the filesystem and SQLite honoring their sync guarantees.

## Activation blockers and operating limits

- No authenticated generation-bound upload/download/commit dispatch, signed
  generation/intent credentials, quota/reservation integration, abandonment
  recovery, or runtime cleanup orchestration is implemented here.
- No legacy adoption or migration is provided. Incomplete slots and unregistered
  payloads remain retained. Permanent tombstones need an explicit future
  namespace lifecycle policy rather than ad hoc pruning.
- Descriptor views (`/proc/self/fd` or `/dev/fd`), no-follow directory opens,
  hard-link semantics and directory fsync must be supported. Unsupported systems
  fail closed. Qualification here uses a local Linux filesystem.
- The namespace must be exclusively managed by the permitted primitives.
  Arbitrary same-UID/root filesystem mutation, hostile mount replacement,
  deletion/recreation of permanent slots, rollback from an inconsistent backup,
  or disk corruption is outside this protocol. Identity checks detect ordinary
  substitutions; they are not a security boundary against an actor who can
  rewrite the root and its receipts. Device/inode changes during migration or
  restore require an explicit offline protocol and currently fail closed.
  The named-inode check and `rmdir` are separate syscalls; supported primitives
  never rename or recreate a payload, and these checks do not prevent arbitrary
  concurrent rename by another filesystem writer.
- Runtime activation also needs backup/restore consistency across SQLite and
  bytes, a qualified durable deployment, and complete canonical writer coverage.
  A passing test-only lane does not enable or certify production garbage collection.

## Dormant authenticated transfer factory

`createFsGenerationGateway` is outside `server/api`. It is unregistered and
returns 404 by default before inspecting a request or resolving dependencies.
Its explicit dependencies include the immutable store, namespace, selected
canonical reader, signing secret, and a qualified version-1/upload-version-1
coordinator bound to `fs`. Namespace and provider mismatches fail before allocation.
It advertises neither deletion coordination nor an external-generation capability.
No deployment flag, migration execution, or legacy adoption is enabled here.

The test-only composition injects its adapter into the real host presign-upload,
commit and presign-download routes. Those routes retain their current session,
workspace permission, origin, bounded JSON body, MIME/capability, quota precheck
and rate-limit policy. Binary handler factories must be mounted explicitly; the
URLs returned by this factory have no registered production handler.

1. Presign authorizes the internal session user and `workspace.write`. A fresh
   UUID generation/intent is reserved atomically in the canonical shared quota
   ledger before allocation. Durable readiness is independently inspected and
   recorded before any credential is issued. Limits default to 100 MiB and 300
   seconds, with a maximum 900-second factory lifetime; subsecond requested TTLs
   clamp to one second. The coordinator also bounds pending allocation count,
   including zero-byte allocations.
2. Upload credentials use distinct `generation_upload` operations, version,
   audience and issuer. They bind provider pair, namespace, workspace, internal
   user, generation, intent, SHA-256, exact safe-integer size, MIME and deadline.
   Legacy endpoints reject these operations even under the same signing secret;
   new handlers reject legacy credentials. PUT rechecks session/write permission,
   browser mutation origin/intent, owner-bound durable intent and readiness. It
   streams with a deadline and independently verifies exact bytes. It rechecks
   intent/deadline after streaming; it does **not** canonically publish anything.
3. Commit is a separate, freshly authenticated request. It refuses restore
   tickets and every changed binding, independently rehashes persisted bytes,
   then atomically calls `publishGenerationUpload`. Publication cannot refresh
   an expired intent or revive a claimed identity. The shared quota hold remains
   until exact live metadata consumes it, including when source references arrive
   first. Credential expiry alone never releases that accounting charge.
4. Download tokens use `generation_download` and bind the current reader, without
   uploader intent ownership. Every GET rechecks current session/read permission,
   exact live canonical metadata and the exact verified generation. A token never
   follows a mutable hash head to a successor. Canonical metadata has no separate
   provider field: an exact validated FS namespace storage ID plus the qualified
   `fs` coordinator provides target provenance. A descriptor-pinned file is
   rehashed before streaming. Safe canonical MIME/disposition/filename policy,
   `nosniff` and private/no-store headers are retained. The stream owns its file
   descriptor through EOF, errors, cancellation and already-disconnected clients.

Authorization is request-time. The host session resolver caches within one
request; this factory does not claim an immediate role-revocation barrier during
streaming. A midstream revocation can leave retained bytes, but a fresh commit
must reject canonical publication. Supported authenticated browser downloads and
credential-forwarding server fetches retain session checks. An external model or
worker anonymously fetching a signed FS URL is unsupported. Existing host model
attachment consumers obtain authenticated bytes before constructing data URLs.

## Ready-only recovery and retained uncertainty

The explicit `recover` method is a trusted-server factory operation, not an
HTTP endpoint or scheduled job. It pages at most 100 canonical bindings and
reports per-intent retained/pending/abandoned outcomes. The listing itself is
never deletion authority. A reserved binding may be reconciled only using an
independent durable readiness receipt; this does not extend its upload deadline.
Missing slots, incomplete initialization and old manifests without a receipt
remain retained/unknown. A paused allocator may resume; absence is not proof
that initialization is permanently fenced.

Expired ready uploads and qualified expired restore holds use their distinct,
irreversible canonical abandonment claims. `removeAbandoned` independently reads
that exact durable claim and compares provider, workspace, namespace, generation,
hash, size, storage ID, intent, claim and persisted receipt before selecting the
payload. Published generations are fenced in the same canonical transaction.
Completion is acknowledged only after durable payload absence; pending writers,
unknown files or failed verification remain pending. Permanent slots stay in
place. No response claims disk bytes were reclaimed: open file descriptors and
other filesystem effects can retain physical blocks after unlink.

The legacy read-only usage observer does not classify this namespace. If
`generations-v1` exists it reports `filesystem.complete: false`,
`generationNamespaceBytes: null` and `generation_namespace_unclassified` rather
than reporting a generation-only root as empty/complete. Legacy counters remain
bounded partial observations. Recovery state is not a physical usage measure.

## Remaining activation prerequisites

- No generation adapter/handler or capability is registered. Existing legacy
  runtime behavior and disabled physical deletion remain unchanged.
- Presign retries after a lost response do not recover opaque IDs. A new request
  may encounter the held same-hash reservation until safe ready recovery. Internal
  same-identity coordinator retries are idempotent; client retry/lookup is a
  separate prerequisite and is not claimed solved here.
- Pre-ready reclamation requires a permanent initialization fence competing with
  allocation, plus a qualified reconciliation policy. This tranche retains it.
- The restore quota API is dormant. No existing client restore roundtrip invokes
  it automatically, and restore tickets never authorize byte upload/publication.
- This adapter accepts immutable storage IDs only. Wholesale selection would
  hide legacy metadata without a separately qualified mixed-format read
  dispatcher. There is no automatic legacy adoption or deletion fallback.
- Operational provisioning, secret rotation, rollout/version fencing, supported
  filesystem durability, backup pairing and runtime failure reporting still need
  explicit qualification. Tests do not prove power-loss durability or protect
  against arbitrary same-UID/root filesystem mutation.
- Existing workspace soft-delete/restore flag behavior is unchanged. Hard purge
  of managed generations, permanent bindings and associated upload-intent ledger
  rows is intentionally rejected, including terminal rows. Managed tables do not
  cascade from workspace/user deletion; deleting an owner row alone can leave
  retained records. Activation requires a generation-aware purge/erasure path
  that preserves stale-writer fencing. This tranche implements no such purge.

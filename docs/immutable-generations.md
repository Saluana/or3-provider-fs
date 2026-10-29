# Dormant immutable-generation filesystem protocol

`fs-generations.ts` is an internal, unwired primitive. No route, token, adapter,
registry, cleanup job, or capability flag uses it. Production deletion remains
disabled. Existing content-hash paths are legacy, unmanaged, and never selected.

## Namespace and publication

An explicitly provisioned, UUID-bound namespace contains permanent generation
slots: `generations-v1/workspaces/<workspace>/<generation UUID>/`. A slot holds a
permanent `ready.json` manifest and a removable `payload/` directory. The manifest
binds workspace, generation, SHA-256, size, namespace, storage ID, and payload
device/inode. Namespace and generation IDs must be fresh UUIDv4 identities.

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

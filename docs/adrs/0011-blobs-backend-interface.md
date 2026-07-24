# 11. Blobs sit behind a Backend interface with a local filesystem implementation

- Status: Accepted
- Date: 2026-07-18

## Context

Files should be content-addressed and E2EE, with the bytes riding a separate data plane
from chat. The vision specifies an `iroh-store` data plane (BLAKE3-addressed, verified
resumable range reads, pinning), but no `iroh-store` daemon exists in this environment.

## Decision

A file on chat is a tiny **`file_ref` envelope** `{hash, wrapped_key, mime, size,
thumb?}`; the bytes live on a data plane behind a **`blobs.Backend`** interface
(`Put`/`Get`/`GetRange`/`Has`/`Pin`). The shipped implementation is a **local
filesystem** backend. Content addressing is **BLAKE3 over the *encrypted* bytes**, so a
backend never sees plaintext. `blobs/iroh` drops in behind the same interface later.

## Consequences

- Content addressing, per-file key wrapping, range reads, and honest retrieval states
  (`available` / `pending` / `downloading` / `broken`) are all real and exercised.
- Deferred: the actual iroh data plane — peer-to-peer verified resumable fetch, real
  pinning. **The interface is the contract; the local backend is the placeholder.**
- Mesh never carries file bytes — envelope only — a rule independent of the backend.

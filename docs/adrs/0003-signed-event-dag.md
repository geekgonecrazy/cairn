# 3. Everything is a signed, content-addressed event in a per-room DAG

- Status: Accepted
- Date: 2026-07-18

## Context

A local-first, multi-transport system needs state that converges without a trusted
server, survives partitions, and can flow over any transport (LAN, mesh, relay) without
a hop being able to forge or reorder it.

## Decision

Everything that happens — a chat message, a reaction, a room being created, a member
added, a key rotated — is an **Event**: a signed, content-addressed record in a
**per-room DAG** with causal `parents`.

- `content = det-CBOR([sender_pub, room_id, ts, sort(parents), type, payload])`
- `event_id = BLAKE3-256(content)` — the content address
- `sig = Ed25519(sender_priv, event_id)`

Merge is **hash-set union** (`event_id` dedups) — commutative, associative, idempotent.
Concurrent events (neither an ancestor of the other) tiebreak by **lower `event_id`**.
Sync is a **per-peer frontier diff** — "what you have vs what I have" — not a queue.

## Consequences

- The server is **convenience, not authority**: events verify on their own and the DAG
  converges without it. Two clients can converge directly.
- The **same signed bytes travel over every transport**; a relay or mesh hop moves
  opaque frames and can neither forge nor reorder them.
- Out-of-order delivery is the normal case; a dropped realtime frame is never a lost
  message, because the next sync fills the gap.
- Ordering is **causal, never wall-clock** — `ts` is advisory.
- This is not Matrix-style state resolution; it borrows from Scuttlebutt / iroh-gossip /
  Automerge.

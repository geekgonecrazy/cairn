# 4. Established cryptographic primitives only, over deterministic CBOR

- Status: Accepted
- Date: 2026-07-18

## Context

Rolling custom cryptographic constructions is a reliable way to ship a quietly broken
system. Cairn's security rests entirely on its crypto, so the crypto must be boring.

## Decision

Use only established primitives, and never invent:

- **Ed25519** — signatures (events, identity objects, invites).
- **BLAKE3-256** — content addressing / `event_id` / object hashes.
- **AES-256-GCM** — room payload encryption.
- **X25519-HPKE** (RFC 9180 base) — wrapping room keys to recipients.
- **WebAuthn** — the browser device key (planned).

All canonical content and payloads are encoded with **deterministic CBOR**
(RFC 8949 §4.2) — sorted keys, shortest-form integers — so there is exactly one byte
form to hash or sign.

## Consequences

- Every security property reduces to a well-studied primitive; there is no novel
  construction to audit.
- Deterministic CBOR gives a single canonical encoding shared by event content, identity
  objects, approval artifacts, and inlay-declaration hashing — the basis for
  cross-language byte parity ([ADR-0005](0005-cross-language-byte-parity.md)).
- It is a standing constraint: a new feature must express itself in these primitives
  rather than reach for something bespoke.

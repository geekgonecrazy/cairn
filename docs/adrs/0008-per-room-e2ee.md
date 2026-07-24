# 8. Per-room E2EE: a per-epoch AES-256-GCM key, HPKE-wrapped to device keys

- Status: Accepted
- Date: 2026-07-18

## Context

Rooms must be end-to-end encrypted so the relay — and every transport between nodes —
only ever handles ciphertext, while membership can still change over time.

## Decision

Each room has a symmetric **AES-256-GCM** key per **epoch**; payloads name their
`key_epoch`. **Join and leave both rotate** to a new epoch: a fresh room key is generated
and **HPKE-wrapped to each current member's device keys** (devices are the unwrap target,
because the member root holds no live secret — [ADR-0007](0007-device-delegation-tree-revocation.md)).
The AEAD's AAD binds each ciphertext to its envelope fields, so a payload cannot be moved
onto another event. Room-state and key-material events are cleartext at epoch 0 (a
not-yet-member must be able to fold them). **Pre-join history is opaque** to new members.

## Consequences

- The server never holds a room key — it stores and routes ciphertext only. "Trusted
  relay" ([ADR-0014](0014-relay-operational-admission.md)) never means trusted with
  content.
- Rotation gives forward secrecy **past a membership change** (a Megolm-class property);
  pre-join opacity is deliberate, not a gap.
- Removing a member protects the **future**, not the past: messages they already hold stay
  readable, because keys can't be un-shared.
- Admitting a member requires wrapping to their whole **non-revoked device set**, which
  the store computes by expanding the member into its device tree.

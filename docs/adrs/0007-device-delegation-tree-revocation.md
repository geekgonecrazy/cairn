# 7. Devices form a delegation tree; revocation is ancestor-only and cascades

- Status: Accepted
- Date: 2026-07-18

## Context

A member uses several devices, and losing one is ordinary. The system needs multi-device
identity where a stolen device can be cut off cleanly — without that device being able
to mint a replacement or lock out the others.

## Decision

Devices form a **delegation tree** under a **member root**. The member root signs the
member's **first** device delegation and then goes **offline**; every later device is
paired from an existing device, whose key signs as parent. A verifier walks a signing
key up the tree — `session → device → … → device → member root` — bounded and
cycle-guarded.

- **Room keys wrap to device keys**, not the member root: the member root holds no live
  secret, so a stolen device cannot admit itself a sibling.
- A **`DeviceRevoke` binds only when signed by an ancestor** of its target. Revocation is
  checked at **every hop**, so revoking a device invalidates its **entire subtree**
  without naming any descendant. **Revocation wins** over order/timestamp, and a revoked
  key can **never be re-paired**.

(What sits at the *top* of the tree — a member's own self-sovereign key — is
[ADR-0013](0013-pubkey-identity-no-household.md).)

## Consequences

- Revoking a device takes down everything paired from it, on **every** verifier — even
  ones offline at the time — because the identity log is an order-independent set.
- **Peers and siblings cannot revoke each other**; a compromised device damages only what
  it was responsible for. Cost: revoking your *first* device needs the member's recovery
  words (only the member root is an ancestor of everything).
- The cascade is automatic for **authentication only**. A revoked device still physically
  holds keys it was wrapped, so key **rotation must exclude the whole revoked subtree**
  ([ADR-0008](0008-per-room-e2ee.md)) — excluding only the named device is the easy bug.
- Pre-revocation history stays readable to the revoked device; keys can't be un-shared.

# 13. Identity is a self-sovereign public key; no household root

- Status: Accepted
- Date: 2026-07-24
- Supersedes the earlier household-root identity model (offline BIP-39 apex above member roots,
  per-member `cairnctl` attestation, carrier chain gate), which no longer exists in the code.

## Context

An earlier model rooted trust in an offline "household" apex that signed an attestation
per member. It was clunky to operate (an apex ceremony + a CLI attestation per join) and
hostile to exactly the ad-hoc, cross-domain transports that are the point: on BLE or
Meshtastic there is no shared household root to chain to, and no server present to admit
you. Identity needs to work across a person's devices, across relays, and on mesh —
without any central authority that could forge members or that must be online.

## Decision

Identity is a **self-sovereign Ed25519 member key**. There is no household root and no
server-issued identity. The member key **self-attests** its profile (kind, display name,
operating human for agents), and sits at the top of its own device-delegation tree
([ADR-0007](0007-device-delegation-tree-revocation.md)). Whether to **trust** a key is an
**edge decision** — you verified it (QR/fingerprint pairing, or trust-on-first-use), or a
room you're in admitted it — not a chain to some apex.

## Consequences

- Onboarding is "generate a key" — no apex ceremony, no CLI, no invite required for an
  identity to *exist*. (Joining a *relay* may still need an invite —
  [ADR-0014](0014-relay-operational-admission.md) — a separate, operational concern.)
- The same key works on any relay and on mesh; identity does not depend on a server being
  reachable.
- Cost accepted: key verification moves to the **edge** — you must confirm a key really is
  your contact's. Transitive room trust, the relay directory
  ([ADR-0015](0015-relay-directory-edge-trust.md)), and fingerprints soften this; none is
  a cryptographic guarantee.
- What is lost vs. the household model: a single, centrally-revocable "these are my
  people" roster. That was the friction; per-room membership + a relay's allow-list cover
  the operational need.

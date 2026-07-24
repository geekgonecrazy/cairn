# 14. The relay is convenience, not authority: allow-list + single-use invites

- Status: Accepted
- Date: 2026-07-24

## Context

With no household apex ([ADR-0013](0013-pubkey-identity-no-household.md)), a relay still
needs a way to control who it will carry — for anti-spam and to be a community boundary —
without becoming a trust authority and without ever seeing message content.

## Decision

The relay has its own **keypair** (clients pin its pubkey) and an **allow-list** of member
roots it will carry. `SubmitEvent` gates on that list. The default is **open**: any valid
sender is admitted **trust-on-first-use** and recorded, so the operator can see who's been
carried and switch to **invite-only** (a config flag) later. Invites are **single-use,
relay-signed tokens** (`cairn:invite:1:…`) redeemed to join the allow-list; the operator
can also `cairnctl allow` directly.

This is **operational admission** — who may *use* the relay — kept strictly separate from
**identity trust** (per-key, at the edge) and from **content** (E2EE,
[ADR-0008](0008-per-room-e2ee.md)).

## Consequences

- "Trusted relay" means trusted to **carry and route**, never trusted with identity or
  messages. Three independent concerns: who may use the relay, whose identity you believe,
  and who can read a room.
- **Revoke = drop from the allow-list**: a moderation lever that touches storage only, not
  a person's identity or their reach via other relays / mesh.
- Open + TOFU keeps first-run frictionless while still producing a real roster. Because
  creating an identity is local, invite-only is enforced at *send* time, and the client
  learns the requirement up front (via `RelayInfo`) so onboarding can demand an invite.
- A relay is a single node; **multi-relay bridging is not built yet** — the transport seam
  ([ADR-0016](0016-transport-seam.md)) is the hook for it.

# 10. The capability broker is external; Cairn produces portable signed artifacts

- Status: Accepted
- Date: 2026-07-18

## Context

Agents sometimes need human authority to act, and the resulting grant must be usable
**outside** Cairn — presented to whatever service mints the actual credential — not just
inside a room.

## Decision

The capability **broker is not a Cairn component**; it is an external service that mints
credentials (an attenuated, time-boxed token). Cairn's role is **delivery + the human
signature**: it carries the `approval_*` event family, renders the request as an inlay
with its capability and scope **visible**, and lets the human sign a **grant with their
own key**. The grant is signed over its **own canonical bytes** (not merely the room
envelope), so it **verifies standalone** — outside Cairn, with no room key and no event
envelope. Cairn never verifies policy, mints credentials, or keeps a consumed-id cache.

## Consequences

- "The room is the delivery medium, not the capability boundary."
- A compromised broker can **deny but cannot fabricate** "the user said yes" — it must
  present the user's real signature.
- Room payloads stay fully E2EE ([ADR-0008](0008-per-room-e2ee.md)): the agent is a room
  member, decrypts, and carries the artifact out — no cleartext authority payloads needed.
- The signed `type` tag ([ADR-0006](0006-typed-identity-log-objects.md)) is what lets a
  broker holding a bare blob tell a grant from a deny.

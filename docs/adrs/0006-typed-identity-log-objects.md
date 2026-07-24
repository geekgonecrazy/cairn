# 6. Identity-log objects carry a type tag inside their signed bytes

- Status: Accepted
- Date: 2026-07-18

## Context

The identity-log objects — attestation, device delegation, session delegation, revoke —
and the portable approval artifacts share field names. Without a discriminator, one
shape can partially decode as another, and a signature could transfer between types
(a `Deny` read as a `Grant`, a session delegation filed as a device delegation).
Discriminating by "which shape happens to verify" only works by accident of the current
field layout.

## Decision

Every identity-log object and approval artifact carries a **`type` tag inside its signed
bytes**. Parsing reads the tag and dispatches to exactly that shape; verification checks
the tag **before** the signature. Signing forces the canonical tag, so nobody can sign
an object wearing another type's tag.

## Consequences

- Parsing is deterministic — read the tag, dispatch — with no speculative
  decode-as-each-candidate and no load-bearing attempt ordering.
- The tag is **domain separation**: cross-type confusion now requires forging Ed25519,
  not finding two shapes whose canonical encodings collide. This matters most for a
  broker holding a bare approval blob: a signed `Deny` must never verify as a `Grant`
  ([ADR-0010](0010-external-capability-broker.md)).
- Untagged objects (anything predating the tag) no longer verify — a deliberate wire
  break, cheap under the dev-phase policy ([ADR-0001](0001-dev-phase-freely-breakable.md)).

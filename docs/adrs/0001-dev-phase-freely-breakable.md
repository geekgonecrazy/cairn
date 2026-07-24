# 1. Dev phase: the wire and schema are freely breakable until real users

- Status: Accepted
- Date: 2026-07-18

## Context

Cairn is pre-release with no external users. Carrying backward-compatibility,
versioned enums, and migrations from day one would slow the design's convergence for
no one's benefit.

## Decision

Until we **explicitly declare "real users,"** the proto, the CBOR payload schemas, and
the SQLite schema are **freely breakable**: edit in place, no versioning, no migrations,
and **wipe the DB to reset**. Backward-compat, additive-only wire changes, stable enum
numbers, and real migrations begin **only** at the real-users switch. History will be
squashed before going public.

## Consequences

- The store has one `CheckDb` that (re)creates the schema; there is no migration code.
  Resetting = delete `cairn.db*` (and clear the browser's site data).
- Wire breaks — adding a type tag ([ADR-0006](0006-typed-identity-log-objects.md)),
  changing the attestation shape ([ADR-0013](0013-pubkey-identity-no-household.md)) —
  are cheap: regenerate the conformance vectors and move on.
- This guarantee **ends at the real-users switch**. Every "cost accepted: a wire break"
  elsewhere in these ADRs is only cheap *because* of this one.

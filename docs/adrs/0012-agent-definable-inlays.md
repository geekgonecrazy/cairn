# 12. Inlays: one fixed role renderer over content-addressed, author-trusted declarations

- Status: Accepted
- Date: 2026-07-18

## Context

Agents need to present structured UI — progress, task lists, approvals — without bot
spam, and without the client having to ship a bespoke card for every shape an agent
might ever want. Letting agents send arbitrary markup or code would be a security hole.

## Decision

One **fixed role renderer** interprets a small primitive vocabulary; UI is expressed as
**declarations** — *data, never code or pixels*. A declaration is content-addressed
(`decl_cid` = BLAKE3 of its deterministic CBOR); an agent publishes one into a room
(`inlay_decl`) and receivers learn it **by verified hash**. Rendering is **default-deny**
in tiers: the one shipped declaration (`approval_prompt`, pinned because an approval
prompt must never be author-defined — it is a phishing surface), declarations an admin
allowed in the room, and declarations **published by a current room member**
(trust-by-author). Every instance carries a mandatory `text` fallback. Widgets — actual
code — stay gated and never inline.

## Consequences

- An agent that is a room member can compose UI the client never shipped. Because the
  renderer accepts no script, markup, or colour, the worst a member can declare is a
  *misleading card* — no worse than the chat text beside it.
- A declaration renders only once it has arrived: on a partition an instance shows its
  `text` line until the declaration syncs, and an agent removed from a room leaves its
  cards degraded (no author left to trust).
- `decl_cid` byte-identity across Go and the browser is load-bearing (Go publishes, the
  browser verifies) — covered by [ADR-0005](0005-cross-language-byte-parity.md).

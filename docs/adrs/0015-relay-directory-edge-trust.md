# 15. The relay directory enables add-by-name; trust is decided at the edge

- Status: Accepted
- Date: 2026-07-24

## Context

Adding someone by pasting a raw 64-hex member key is hostile UX. But a display name is
the classic impersonation surface — a name is a trust claim, and a wrong one is worse
than none.

## Decision

The relay serves a **directory** of its allow-listed members that have published a
self-attestation — `{member_pub, display_name, kind}` — which backs **add-by-name** in the
client. A directory name is the **"relay-vouched"** tier: as trustworthy as the operator's
curation of the allow-list ([ADR-0014](0014-relay-operational-admission.md)), **not** a
cryptographic guarantee. The **name is a label; the pubkey is the identity**, and
`MEMBER_ADD` binds to the pubkey. For anything sensitive, trust is decided at the **edge**
(fingerprint comparison / pairing).

## Consequences

- Add-by-name covers the common case, with add-by-key as the fallback.
- The client shows a **verification tier** — self-asserted display name, relay-vouched, or
  (future) a petname you verified out of band — so a name never silently reads as proof.
- The directory exposes member ids and names to whoever queries it: a privacy tradeoff
  accepted for the ergonomic win.
- A client-pinned relay key + an AUTH handshake, and "verified petname" storage, are still
  ahead.

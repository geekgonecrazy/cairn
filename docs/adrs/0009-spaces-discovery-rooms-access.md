# 9. Spaces grant discovery, rooms grant access; the creator is the authority

- Status: Accepted
- Date: 2026-07-18

## Context

Members need to discover that rooms exist without automatically being able to read them,
and a group needs a clear authority over its membership so removal is not ambiguous.

## Decision

Two nested concepts with different jobs:

- A **space** is a discovery scope. Space membership lets you *see* the space's
  discoverable rooms — and nothing more; it **wraps no key**.
- A **room** (channel) is where messages live. Room membership means **holding the room
  key**, which only a `MEMBER_ADD` grants.

The space's **creator** (its member root, recorded at fold time) is its **sole
authority**: only they may add/remove space members or update the space, **enforced at
the fold** (a change from a non-owner is dropped, not merely hidden). A room roster must
stay a **subset of its space roster**; because room keys live with channel members (not
the space owner), that invariant is enforced client-side — a key-holder drains anyone no
longer a space member.

## Consequences

- What you can see is always the result of a signed act naming you; a household's room
  list can't leak through a single shared channel. Hidden rooms are shown only to a
  member a `MEMBER_ADD` actually admitted.
- The space→channel cascade is **eventual and online-triggered**: only a key-holder can
  rotate, so a channel with no online member isn't drained until one returns.
- Deferred: the creator cannot yet promote other admins, and the client trusts the
  owner-enforced server fold rather than fully re-verifying the space's authority.

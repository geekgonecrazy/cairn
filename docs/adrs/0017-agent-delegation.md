# 17. Agents are delegated principals: human-signed vouches, transfer by re-attestation

- Status: Accepted
- Date: 2026-10-06

## Context

Agents are first-class participants ([ADR-0012](0012-agent-definable-inlays.md)): an
agent holds its own member root, self-attests `kind=agent`, and speaks the same
signed events as a browser. But the `operated_by` field on its self-attestation
is signed **by the agent's own key** — "I belong to Aaron" is a claim the agent
makes about itself, verifiable by nobody. Two things are needed:

1. Creating an agent identity must be easy for a logged-in human, and the
   resulting agent must be handable to an agent harness that bootstraps itself.
2. "This agent is mine" must be cryptographically real, transferable to someone
   else later, and killable — without digging out the member-root words.

Constraints: the browser never holds the member private key (vault discipline),
so a human's vouch must be signable by a **device key**. And a single-device
vouch would couple the agent's life to that device — a stolen laptop revoking
itself would destroy your agent, i.e. a denial-of-service lever against you.
Cascade-on-revoke ([ADR-0007](0007-device-delegation-tree-revocation.md)) is the
right semantic for *authority* ("this key may act as me") and the wrong one for
*attribution* ("this agent is mine"). An agent acts as itself and never as you;
a stolen device holds no agent secret, so there is nothing to cascade.

## Decision

Ownership is **stated by the agent** (its self-attestation names `operated_by`)
and **proven by surviving vouches** from that operator's device tree. Two new
identity-log objects:

- `agent_delegation { agent_pub, delegator_pub, operator_pub, issued_at,
  expires_at?, sig }` — signed by the delegator device. The delegator must
  resolve (walk + revocation checks, the existing machinery) to `operator_pub`,
  or BE the operator root (a durable, words-signed vouch the cascade cannot
  touch). Crucially the vouch **names the operator**, and validates only while
  `operator_pub` equals the agent's attested `operated_by`.
- `vouch_withdraw { agent_pub, delegator_pub, withdrawn_at, sig }` — signed by
  the delegator itself. Self-withdrawal needs no authority proof, because a
  device withdrawing its own vouch is uncontroversial. It kills that
  delegator's vouches issued at or before `withdrawn_at`; a later re-vouch is
  live again.

An agent is **proven** while ≥1 vouch survives (valid sig, unexpired,
delegator resolves to the attested operator, not withdrawn, not revoked).
Revoking a device removes only its vouch — the agent survives on the others.
An **unproven** agent (names an operator, no surviving vouch) still RESOLVES;
it is a proof state, not an error. `SubmitEvent` accepts it; clients show the
honest state.

**Transfer needs no new object.** The agent re-attests with a new
`operated_by`, the new operator vouches, and the old operator's vouches void
automatically (they name an operator that no longer matches). Only the agent's
own key can move it — you cannot force-transfer someone else's agent, only
revoke your own. No-lockout properties:

| | Can escape | Needs the other party |
|---|---|---|
| Agent leaves | yes — re-attests; old vouches void on their own | no |
| Operator re-proves | yes — fresh vouch, fresh expiry, any time | no |
| Operator kills the agent | yes — withdraws its vouches | no |
| Disabled agent returns uninvited | **no** | needs a fresh vouch |

**Attestation supersession** (needed for transfer, and for renames generally):
latest `issued_at` wins, ties broken by greatest content hash — deterministic
and order-independent across replicas. `kind` is earliest-issued-wins, keeping
the immutability rule without order-dependent insert rejection. Clock caveat
accepted: a bad clock can only stop an agent superseding its *own*
attestation, never lock anyone else out.

## Consequences

- `operated_by` stops being self-declared the moment a vouch exists, because
  the vouch is the operator's signature, not the agent's claim. An unvouched
  agent is honestly unproven rather than silently trusted.
- Multi-device vouches are the redundancy story: vouch from each live device
  and no single revocation kills the agent.
- Relay admission and `admit_kind` enforcement are NOT changed here: an agent
  is still admitted (or not) as its own member root. Operator-based admission
  ("carried because its operator is") is a deliberate policy follow-up, not
  smuggled in with the trust objects.
- UI creation, the harness handoff bundle, and the e2e proof sit on top of
  this and are separate slices.

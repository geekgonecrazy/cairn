# Architecture Decision Records

Short records of the decisions behind **what Cairn currently is** — one decision
per file, in the [Michael Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
style (Context → Decision → Consequences). Each is a decision reflected in the
*built* system.

They are numbered **chronologically**: 0001–0012 are the foundational decisions
(≈2026-07-18), 0013–0016 are the v2 trust-model decisions (2026-07-24), and 0017
is the agent-delegation decision (2026-10-06). Designs that
were tried and superseded along the way (household roots, the CLI founding flow) are
noted in the ADR that replaced them; each record captures the decision and its context
on its own. These ADRs are the current, authoritative view.

| # | Decision | Date |
|---|----------|------|
| [0001](0001-dev-phase-freely-breakable.md) | Dev phase: the wire and schema are freely breakable until real users | 2026-07-18 |
| [0002](0002-stack.md) | Go backend, Svelte PWA, pure-Go SQLite, ConnectRPC + SSE | 2026-07-18 |
| [0003](0003-signed-event-dag.md) | Everything is a signed, content-addressed event in a per-room DAG | 2026-07-18 |
| [0004](0004-established-primitives-only.md) | Established cryptographic primitives only, over deterministic CBOR | 2026-07-18 |
| [0005](0005-cross-language-byte-parity.md) | Go and the browser are kept byte-identical by conformance vectors | 2026-07-18 |
| [0006](0006-typed-identity-log-objects.md) | Identity-log objects carry a type tag inside their signed bytes | 2026-07-18 |
| [0007](0007-device-delegation-tree-revocation.md) | Devices form a delegation tree; revocation is ancestor-only and cascades | 2026-07-18 |
| [0008](0008-per-room-e2ee.md) | Per-room E2EE: per-epoch AES-256-GCM key, HPKE-wrapped to device keys | 2026-07-18 |
| [0009](0009-spaces-discovery-rooms-access.md) | Spaces grant discovery, rooms grant access; the creator is the authority | 2026-07-18 |
| [0010](0010-external-capability-broker.md) | The capability broker is external; Cairn produces portable signed artifacts | 2026-07-18 |
| [0011](0011-blobs-backend-interface.md) | Blobs sit behind a Backend interface with a local filesystem implementation | 2026-07-18 |
| [0012](0012-agent-definable-inlays.md) | Inlays: one fixed role renderer over content-addressed, author-trusted declarations | 2026-07-18 |
| [0013](0013-pubkey-identity-no-household.md) | Identity is a self-sovereign public key; no household root | 2026-07-24 |
| [0014](0014-relay-operational-admission.md) | The relay is convenience, not authority: allow-list + single-use invites | 2026-07-24 |
| [0015](0015-relay-directory-edge-trust.md) | The relay directory enables add-by-name; trust is decided at the edge | 2026-07-24 |
| [0016](0016-transport-seam.md) | Transports plug into one interface; the node treats them uniformly | 2026-07-24 |
| [0017](0017-agent-delegation.md) | Agents are delegated principals: human-signed vouches, transfer by re-attestation | 2026-10-06 |

Status values: **Accepted** (in force). A decision later replaced gets a new ADR
and the old one is marked **Superseded by ADR-NNNN**.

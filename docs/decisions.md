# Cairn — decisions & context log

Durable record of the Cairn planning conversations. **Sections are labelled by status** — what the
user actually *decided*, what's still *open*, and *reference* facts pulled from the vision docs.
Nothing in "Open" or "Reference" is a settled decision.

Companion to [`plan.md`](./plan.md) (the build plan) and the design mockup in
[`claude-design/`](../claude-design). Architecture source of truth: `/root/code/vision/systems/cairn/`
(`protocol.md`, `inlay.md`, `ux.md`, `README.md`), `systems/identity/web.md`,
`systems/data-plane/README.md`.

---

## Trust model v2 — pubkey identity + relays, no household root — decided (direction) 2026-07-24

> **Status: DECIDED DIRECTION, not yet implemented.** The code today still implements the
> household-root model (offline BIP-39 apex, `cairnctl` attestation, the carrier chain gate)
> documented in [`events-and-e2ee.md`](events-and-e2ee.md). This entry records where we are
> taking it. It **supersedes**, for the v2 direction, the household-era decisions below:
> *Household-root bootstrap & recovery*, *Founding and attestation move to the CLI*, *Member
> root goes offline; devices form a delegation tree* (the device **tree** itself is kept), and
> *Chain gate: default-deny + founding-window adoption*; and it reframes *Two-tier membership*
> and *Space is the authority*. Until the rework lands, the old model stands.

**Why.** The household root is an offline BIP-39 apex that must sign an attestation (via
`cairnctl`) to admit every member. That is (a) clunky — a CLI ceremony per join — and (b)
hostile to exactly the transports we want most: BLE and Meshtastic are ad-hoc,
infrastructure-less, and cross-domain, where a strict "chain to a shared household root" gate
rejects everyone you meet. A multi-pass design conversation (2026-07-24), taking inspiration
from Nostr, concluded the household apex solves a problem we don't have and blocks the ones we
do.

**The model.**

- **Identity is a public key.** A member is a keypair; multiple devices are handled by the
  existing **device-delegation tree** (kept — a device pairs from an existing device, so no
  secret is copied; strictly better than sharing one key across devices). No household root, no
  offline apex, no per-member attestation ceremony.
- **Trust is per-key, at the edge, and per-room.** You trust a key because you verified it (QR /
  fingerprint pairing, or TOFU) or transitively because a member you trust added them to a room.
  Each **room is its own trust domain, rooted in its creator**; membership + key handoff ride
  the room DAG (`MEMBER_ADD` wraps the room key to a device, as today). There is no global
  "these are my people" roster — that was the clunk.
- **E2EE is absolute and unchanged.** Room keys stay AES-256-GCM per epoch, HPKE-wrapped to
  member devices. Relays never see content, however many they cross. "Trusted relay" only ever
  means trusted-for-routing/availability — never trusted-with-messages.
- **Relays are store-and-forward sync nodes, not authorities.** A relay is a permanent node that
  runs the same frontier sync with clients *and with other relays*. **Relay-to-relay bridging is
  explicit and configurable** (which peers, which transport, which rooms) — and it is the right
  answer for constrained links: bridge two relays over Meshtastic/LoRa or a radio link so local
  clients talk to their local relay and the relays cross the precious link **once** (mesh
  framing, per-type routing, store-and-forward). Clients may also multi-home to several relays
  (cloud redundancy), but that is complementary, not the answer for constrained links. This is
  **transport bridging, not Matrix-style membership/state federation** — no shared authority, no
  global namespace. Loop-safe by `event_id` dedup + frontier sync.
- **Relay access = an invite key + an allow-list.** A relay has a keypair (clients pin it and
  AUTH by signing a challenge). It issues single-use, relay-signed **invite tokens**; redeeming
  one adds a pubkey to the relay's allow-list. This is *operational* (who may use the relay) and
  is separate from identity trust. Revoke = drop from the allow-list — a moderation lever that
  touches storage, never a person's identity or their reach via other relays/mesh.
- **Discovery = a relay directory + add-by-name, with verification tiers.** Members opt in by
  publishing a profile (name + pubkey). Others add by name — but the **name is a label, the
  pubkey is the identity**, and `MEMBER_ADD` binds to the pubkey. The client shows a tier:
  *display name* (spoofable), *relay-vouched* (name→key asserted on the relay's turf; as
  trustworthy as the operator's curation), or *verified petname* (checked out of band; portable
  to mesh and any relay). On an invite-gated relay the allow-list is itself curation, so
  add-by-name is safe for daily use; reserve fingerprint checks for higher-stakes / cross-relay.
- **Interest-based (demand-driven) routing.** A relay carries the *union of what its subscribers
  provably want* plus operator-**pinned** rooms (persistence + store-and-forward). Two proofs
  for two jobs: **relay AUTH** (sign a challenge → hold pubkey P) and a **room-membership
  proof** (present your signed `MEMBER_ADD` for R → you belong in R). The membership proof stays
  **local** (client → its relay). Relay-to-relay bridging exchanges **carry-sets of opaque
  room-ids** and syncs the **intersection** per room — a room spans two relays only if both have
  an interested member (or are configured to carry it). Reuses the existing `peer_frontier`
  machinery. The proof + a per-subscriber fan-out cap is the **anti-abuse gate** (without it a
  client could make a relay fire-hose arbitrary rooms across an expensive bridge — amplification/
  DoS, brutal over LoRa).

**Operational vs. trust — the load-bearing separation.** The household root conflated two things
this model keeps apart: *who may use / be carried by a relay* (operational: invite key,
allow-list, carry config) versus *whose identity you believe* (trust: per-key, at the edge).
Relays own the first; only you own the second. That separation is what lets relays bridge freely
without becoming authorities, and lets trust survive on mesh where no relay is present.

**Guardrail: inspired by Nostr, not implementing Nostr.** Keep Cairn's own stack —
Ed25519/X25519, BLAKE3 content-addressing, deterministic-CBOR + protobuf envelope, the
causal-parents DAG + frontier sync, AES-GCM/HPKE room E2EE. Do **not** adopt Nostr's wire (JSON
events, `kind` numbers, `tags`, secp256k1/schnorr) or treat NIPs as normative — NIP references
(05/42/65) are conceptual analogues only.

**What drops from the code when this lands.** `identity/household.go` (the BIP-39 apex),
`cairnctl init` / `attest`, the household derivation + founding window + root adoption, and the
carrier chain-gate-as-admission (`core.SubmitEvent`'s trusted-root requirement). `trustedRoots`
becomes a relay allow-list + pinned-relay-key + edge key-trust. Onboarding collapses to
"generate a key + redeem an invite"; joining a room stays "a member adds you." **Kept
unchanged:** the event envelope, the DAG and frontier sync, room E2EE and epoch rotation, and
the device-delegation tree.

**Open sub-questions (not blocking the direction).**

- Depth of the membership proof: a bare `MEMBER_ADD` proves *someone* added P, not that they had
  standing. Fine as a routing/anti-abuse gate (the room key is the real boundary); revisit only
  if a concrete threat needs a full add-chain walk.
- Room-id privacy to peer relays: demand routing reveals opaque room-ids and traffic patterns
  across bridges. Private-set-intersection / bloom-filter interest exchange is a future option.
- Identity recovery without an apex: a member is their key; keep per-member BIP-39 recovery words
  for "restore my identity", or lean on device-tree pairing from a surviving device. Decide
  before the rework.
- Directory/profile propagation across bridged relays, and cross-relay discovery hints
  (outbox-style).

---

## Decided (by the user)

- **Stack direction:** frontend **Svelte**; backend **Go**; **SQLite** when a DB is needed; **Wails3**
  for the mobile app. (See `plan.md` §1 for how these compose.)
- **Sources of truth:** the `claude-design/` mockup is the UI source of truth (React files are a
  *picture, not a blueprint*); the vision repo at `/root/code/vision` is the architecture source.
- **Dev-phase policy — no backward-compat burden yet.** Until we **explicitly declare real users**,
  the proto, CBOR payload schemas, and the DB schema are **freely breakable**: edit
  `proto/cairn.proto` and the payload schemas without versioning, change the SQLite schema in place,
  and **wipe the database at will**. **No migrations.** Backward-compat, additive-only wire changes,
  stable enum numbers, and real migrations begin **only** once we flip the real-users switch.
- **The capability broker is NOT a Cairn component.** Corrected 2026-07-18 (earlier drafts of
  `plan.md` wrongly listed a `broker/` package inside Cairn). The broker is a **Capsule
  workload in the agents system** that mints attenuated, time-boxed **JWTs**
  (`systems/agents/README.md`, `systems/agents/framework.md` §"Approval = the credential
  broker", `systems/identity/README.md`); it is a *peer* of Cairn, and currently unbuilt.
  **Cairn's role** is delivery + the human signature: carry the `approval_*` event family,
  render the request as an inlay with capability and scope visible, let the human sign a
  grant **with their own key**, and hand back a **portable signed artifact** the agent takes
  out-of-band to the broker to exchange for a token. Cairn never verifies policy, mints
  credentials, or keeps a consumed-id cache. Two consequences:
  - Artifacts are signed over **their own canonical det-CBOR**, not merely the room envelope,
    so they verify standalone outside Cairn with no room key.
  - The earlier worry about a non-member broker reading E2EE payloads was **moot** — the
    *agent* is a room member, decrypts, and carries the artifact directly. Per
    `framework.md`: *"the room is the delivery medium, not the capability boundary."*
    Room payloads stay fully E2EE; no cleartext authority payloads needed.
- **Unary API binding = ConnectRPC.** Decided 2026-07-18. `buf` + `connect-go` (Go server stubs) +
  `connect-es` (TS client) generated from `proto/cairn.proto`; the `CairnService` service defs are the
  typed surface (`SendEvent`, `Sync`, `History`, `GetIdentityObject`). Diverges from the reference
  repos' Gin REST, but keeps one proto as the single contract for Go + TS. Realtime stays **SSE** (a
  plain HTTP `text/event-stream`, *not* Connect server-streaming) per the SSE decision below. (Resolves
  the earlier ConnectRPC-vs-Gin-REST open item.)
- **Realtime transport = SSE.** User preference; matches `flockledger/controllers/sse.go`. The
  realtime `Subscribe` is a plain HTTP SSE stream of `Event`s; unary calls (send / sync / history) are
  request/response. (Resolves the earlier SSE-vs-WebSocket item.)
- **Code structure follows `geekgonecrazy/rfd-tool` + `fidetechsolutions/flockledger`.** Flat
  top-level Go packages by concern, **no `internal/`**; `store` interface + `store/sqlite` impl;
  a `core` package wired via `core.Setup()` with unexported package-level state; `config.Load` +
  `config.Config`; tiny `cmd/<binary>/main.go`; `models/`; Svelte app in `webapp/`; a `PROJECT.md`
  overview. Module path `github.com/geekgonecrazy/cairn`. Full layout in `plan.md` §2. (Note: their
  realtime precedent is **SSE**, not WebSocket — reconcile with the vision under "RPC library" below.)
- **NATS / JetStream — not now, kept on the table.** Not adopting it for now; revisit if a concrete
  need appears. Reasoning from the discussion: the outbox ("track what hasn't been delivered") is
  better modeled as a **per-peer frontier/cursor over the signed DAG** than a queue — "undelivered to
  X" = DAG − X's acked frontier — because the DAG already provides the durability (the payload can't
  be lost), so a queue would re-store what the DAG already holds. The frontier is the durable truth;
  the active "push now, retry on failure" work-loop is the only genuinely queue-shaped piece.
  **Kept as a candidate for later** if we want: (a) an off-the-shelf engine for that retry work-loop
  (ack / redelivery / backoff), (b) durable intra-host workload⇄workload delivery across restarts /
  live-migration, or (c) convergence with the already-chosen **home-automation NATS bus** (NATS
  speaking MQTT). Guardrails if ever adopted: per-host / additive only (never a global bus), never the
  source of truth or trust path, short / interest-based retention.

### Household-root bootstrap & recovery shape — decided 2026-07-18 (Phase 4)

Closes the open question carried in `plan.md` §5 and `protocol.md` §298. Implemented in
`identity/household.go`.

- The household root is an **offline-only apex**. It signs exactly one object type —
  `IdentityAttestation`, binding a member root to the household — and nothing else.
- It is **derived deterministically from a 24-word BIP-39 mnemonic** and **never persisted**.
  Operations that need it re-derive it from the words, use it, and drop it. No device stores the
  root private key, so no device theft compromises the household.
- The root pubkey **is** the household id and the value that belongs in `trustedRoots`.
- **Recovery = re-derive the root from the words, then re-attest a fresh member root.** Not
  "restore a backup". The household id is unchanged, so peers' existing `trustedRoots` keep
  working. Losing every device still loses the per-room message keys — pre-join history stays
  opaque per §3 — which is a deliberate consequence, not a gap.
- BIP-39 seed → **HKDF-SHA-512 domain separation** (`cairn/household-root/v1`) → Ed25519 seed, so
  the same words can later derive further independent keys without either being able to forge the
  other.
- BIP-39 via `github.com/tyler-smith/go-bip39` rather than hand-rolled, per the "established
  primitives only, no inventing" rule.
- **Consequence to accept:** a wrong BIP-39 passphrase yields a *different household*, not an
  error. That is BIP-39's plausible-deniability property; the UI must make the resulting
  "nobody recognizes you" state legible rather than looking like a bug.

### Founding and attestation move to the CLI (`cairnctl`) — decided 2026-07-18 (Phase 4)

Supersedes the browser-founding path and the "founding window" adoption model below.

**Two reasons, and the security one is the bigger.**

1. **The household's 24 words never touch a browser.** They are the most powerful secret in the
   system — the root can attest ANY member key as ANYONE — and the previous flow asked the
   inviter to type them into a `<textarea>` in `DevicesModal`. A web page is reachable by
   extensions, autofill and devtools history in a way a terminal is not. The design went to real
   lengths to keep this root offline and never persisted, and then put the only UI that uses it
   in the most exposed place available.
2. **Founding decides what the CARRIER trusts, which is server configuration.** `cairnctl init`
   writes the root to `trusted-roots.txt` beside the config, so the chain gate is strict from the
   FIRST event. That removes the trust-on-first-use adoption window entirely.

**What the adoption window actually cost.** It is not theoretical: onboarding twice (clearing
site data and setting up again) minted a second household. Adoption had already latched onto the
first, so every event from the live identity was refused as `ErrUntrustedRoot` — which the error
taxonomy treats as TERMINAL, so it was not retried, just silently marked `queued`. The visible
symptom was "creating a space does nothing at all". `cairnctl init` refuses to found twice, which
makes that state unrepresentable rather than merely diagnosable.

**Shape.**

- `cairnctl init [-name …]` — mint the household phrase, show it once, require three words back,
  write the root to `trusted-roots.txt`. The private key is never written anywhere.
- `cairnctl attest <join-code>` — prompt for the words, sign an attestation, print an invite.
  Refuses if the words derive a household this node does not trust, which is the only way to
  catch a wrong phrase: BIP-39 has no wrong answers, it just yields a DIFFERENT household.
- `cairnctl roots` — what this node trusts, with fingerprints.
- **Everyone joins, including the founder.** The founder is no longer a special case in the app;
  they get one personal phrase like every other member. This retires the two-phrase founder
  onboarding added earlier the same day.
- `trusted-roots.txt` is a separate file, not `config.yaml`: the CLI writes it, and rewriting
  YAML would destroy the hand-written comments. `config.Load` merges the two.

**Consequences to accept.**

- Setting up a household now requires a terminal on the server. For a self-hosted household hub
  where you already ran `cairnd`, that is reasonable — but it does block a non-technical member
  from standing up a node alone.
- The webapp lost `bootstrap()`, `recover()`-with-household-phrase, and `attestJoinRequest()`.
  They are DELETED rather than left unused, so nobody wires them back up.
- Browser recovery now has exactly one path: re-derive the member root from the member's own
  words and pair it with the attestation published when they joined. That needs a reachable
  carrier — an offline restore would require the household phrase, which is precisely what must
  not be in the browser.
- Go gained `identity/invite.go` (join-code and invite-blob encoding), previously browser-only.
  Byte parity is pinned by conformance vectors on both sides. Building it surfaced a real trap:
  a plain `cbor.Marshal(map)` sorts keys lexicographically where canonical CBOR sorts
  length-first, producing a blob that still decodes AND still verifies — the signature covers the
  fields, not the envelope — while being byte-different from the browser's.

### Member root goes offline; devices form a delegation tree — decided 2026-07-18 (Phase 4)

Supersedes the parts of the Phase-4 notes that put the member root on every device and wrapped
room keys to it. Prompted by finding that device pairing could not be completed as designed.

**The contradiction that forced this.** Room keys were HPKE-wrapped to the MEMBER ROOT
(`crypto.ts` `mintEpoch`), so a device could only read a room if it held the member root secret.
But `identity/pairing.go` promised the member root's private key never leaves the trusted device.
Both could not hold, and the consequence of resolving it the easy way is fatal: if pairing hands
the member secret to the new device, then a stolen device **is** the member — it signs itself a
fresh `DeviceDelegation` and walks back in, because the member root is exactly the authority that
admits devices. Revocation would only ever bind against an attacker who chose to cooperate.
That is why device pairing was never finished: it *couldn't* be, as designed.

**The shape.**

- A member root is now an **offline apex**, exactly like the household root: derived from its own
  24-word BIP-39 mnemonic (`cairn/member-root/v1` domain separation), used to sign the member's
  FIRST device delegation, then dropped. Never persisted on any device.
- **Devices delegate devices.** `DeviceDelegation.MemberPub` becomes `ParentPub`, which is either
  a member root (the first device) or another device key. The chain is a TREE per member, and the
  walk `session → device → … → device → member root → household root` is recursive rather than
  the old fixed single device hop.
- **Room keys wrap to DEVICE keys, not member roots.** This is now forced rather than chosen: the
  member root holds no live secret, so it cannot be an unwrap target. Membership stays a
  member-level fact (`models.Member.MemberPub`); decryption becomes a device-level capability, and
  the wrap target set is derived by expanding each member into its non-revoked devices.
- **Revocation cascades for free.** Because the walk checks revocation at EVERY hop, revoking a
  device kills its entire subtree without naming any descendant — on every verifier, including
  ones offline at the time, since the identity log is an order-independent set.
- **Revoke authority is ancestors-only.** `DeviceRevoke.MemberPub` becomes `RevokerPub`, and a
  revoke binds only if the revoker is an ANCESTOR of the target (the member root may revoke
  anything). Peer revocation is deliberately refused: a stolen phone could otherwise revoke the
  laptop, destroying the owner's access permanently — revoked keys can never be re-paired — while
  the attacker kept theirs. A compromised device may damage only what it was already responsible
  for. Cost to accept: revoking your FIRST device requires the member's 24 words.

**Honest properties.**

- The cascade is automatic for AUTHENTICATION only. A revoked device still physically holds the
  room keys it was wrapped, so rotation must exclude the **entire revoked subtree**, not just the
  named device. Excluding only the named device is the easy bug here.
- Pre-revocation history stays readable to the revoked device. Keys cannot be un-shared; this is
  the same limit already recorded for member removal.
- Every member now needs their own recovery phrase, where previously only the founder saw words.
  That is real added ceremony at onboarding, accepted because it is the only version where
  "revoke a device" is true without an asterisk.
- **The founder holds TWO separate phrases**, and they are not interchangeable:
  - *household phrase* — attests new members. Needed whenever someone joins. Can live in a safe.
  - *member phrase* — their own identity. Restores their account, and revokes a device that no
    live device sits above. Must stay reachable, because losing a phone is ordinary.

  Deriving the founder's member root from the household words (different HKDF label) was tried
  first and reverted. It is defensible on *compromise* grounds — whoever holds the household
  words can already attest any member key, so the household phrase is strictly more powerful —
  but that is an argument about compromise, not operation. One shared phrase forces the household
  secret to be as reachable as the personal one, and makes the founder's member root behave
  differently from every joiner's, whose phrase is independent by construction. Onboarding shows
  them one at a time, each separately confirmed, labelled for what it does.
- **Recovery differs by role, and has to.** A founder holds the household phrase and can
  re-attest themselves entirely offline. Everyone else never sees it — their attestation was
  published when they joined, so recovery re-derives the member root from their words and pairs
  it with that fetched attestation, verified locally (`recoverWithAttestation`). The consequence
  to accept: non-founder recovery needs a reachable carrier.
- The recursive walk needs guards a fixed-depth walk did not: **max depth 8**, **cycle detection**,
  and one-parent-per-device (already enforced in `DeviceLog.AddDelegation`, now load-bearing —
  it is what makes the structure a tree rather than a graph).
- **Still missing: there is no way to remove a MEMBER from a household.** No `MemberRevoke` object
  exists. A member root being unrevocable is correct within its own tree, but it also means a
  member cannot be ejected. Recorded as a gap, not solved here.

**Breaking change, accepted.** Existing rooms were wrapped to member roots and become unreadable.
Per the dev-phase policy (no migrations until real users), existing data is abandoned rather than
migrated.

### Space is the authority; channels enforce it — decided 2026-07-18 (Phase 4)

Supersedes the "two independent membership tiers" framing from the two-tier note below.
Space membership and channel membership were independent, which made removal confusing: you
could remove someone from a channel and the space stayed, or revoke space discovery without
touching channel access. The resolution makes the space the single authority per its rooms.

- **Space membership is first-class, revocable, and owner-controlled.** The space **owner** is the
  member root that signed `SPACE_CREATE` (recorded at fold time via `memberRootOf`). Only the owner
  may add/remove space members or `SPACE_UPDATE` the space — enforced **at the fold** (a change from
  a non-owner is dropped, not just hidden), and re-checked by the client. Membership folds
  **last-writer-wins by ts** with a revocation **tombstone**, so a stale/out-of-order `SPACE_MEMBER_ADD`
  can't resurrect a later remove.
- **A channel roster must stay within its space roster.** Adding to a channel requires the target
  already be a space member (client-gated). The space roster is the umbrella; channel rosters are
  subsets.
- **Revocation cascades from space to channels — but E2EE means the owner can't do it alone.** Room
  keys live with channel members, not the space owner, so the owner declares the revocation
  (`SPACE_MEMBER_REMOVE`) and **channel members enforce it**: each client, on sync, reconciles every
  channel it holds a key to toward its space roster — anyone in the channel who is no longer a space
  member is removed (one key rotation to the members who stay, then `MEMBER_REMOVE`). This is
  **state-based, not event-based**: it converges from the current rosters regardless of what events a
  client saw or in what order, so it fires the next time *any* capable member syncs — including one
  that was offline the whole time (`reconcileAllSpaces` on init).
- **Honest properties.** Eventual and online-triggered: a channel isn't drained until an online
  member of *that* channel reconciles — inevitable, but not instant, and impossible for a channel
  with no online members until one returns (only a key-holder can rotate). Concurrent enactors cost a
  few redundant epochs (roster-check converges them). No clawback of history the removed member
  already holds — keys can't be un-shared. `core/rooms_test.go` (`TestSpaceAuthorityAndLWW`) pins
  owner-only enforcement + last-writer-wins; the cascade reconcile is client-side.
- **Deferred:** the owner can't yet promote other admins (creator-only); full client re-verification
  of the space roster's authority (today the client trusts the owner-enforced server fold); and
  rejecting an old-epoch post a removed member could still craft with a retained key (forward-secrecy
  enforcement).

### Chain gate: default-deny + founding-window adoption — decided 2026-07-18 (Phase 4)

Closes the ⚠️ item flagged at the Phase-4 identity slice: `core/events.go` verified sender chains
only when `trustedRoots` was non-empty, and the dev default was empty — so the carrier accepted any
well-formed signed event and **revocation was advisory** (clients labelled a revoked device; the
server still took its posts). `identity.VerifySender` (chain walk + expiry + revoke + trusted-root)
already existed and was tested; the gate was simply off.

**Decision: the carrier is default-deny, and the open question "what does a node that trusts no root
do" is answered by a founding window, not an open mode.**

- **`SubmitEvent` enforces unconditionally.** A sender must chain to a trusted household root. There
  is no accept-all mode — a carrier that can't verify a sender refuses the event.
- **A root-less carrier is *awaiting founding*, not *open*.** It still accepts identity-log objects
  via `PutIdentityObject` (each is individually signature-verified before storing), and the **first
  attestation it stores adopts that attestation's origin as its household root** (`MaybeAdoptRoot`),
  persisted in the `meta` table so it survives restarts. From that instant it enforces. The key
  insight (per the reframe that drove this): the carrier *knows* whether a household exists yet, so
  "no root" is a legible bootstrapping state with a defined exit — founding — rather than a hole to
  leave open.
- **Config pins skip the window.** If `trustedRoots` is set, adoption is off and the carrier is
  strict from t=0 against exactly those roots. A pinned carrier never auto-trusts a household it
  merely met first.
- **Error taxonomy drives client behaviour.** `ErrAwaitingFounding` and `identity.ErrUnknownObject`
  → `FailedPrecondition` = RECOVERABLE: the carrier lacks identity objects it can be given, so the
  client publishes its identity and retries (this is how a founder's first events land — publishing
  the attestation both adopts the root and supplies the chain). Revoked / untrusted / expired /
  bad-signature → `PermissionDenied` = TERMINAL: retrying changes nothing. The webapp's `deliver()`
  republishes-and-retries once on `FailedPrecondition`; a terminal denial stays `queued`.

**TOFU capture, accepted and bounded.** Adopt-first-attestation means whoever founds the carrier
first owns it. For a home appliance the operator onboards before exposing it, and config pins remove
the risk entirely for shared/hardened deployments. A stronger bootstrap handshake remains the
future improvement the milestone anticipated; adoption is the minimal version of it.

**Consequence for multi-household setups.** One carrier adopts one household. The `cmd/agent` demo,
where an agent and a human are *different* households sharing a room, therefore requires the operator
to pin **both** roots in `trustedRoots` (adoption is single-household). Standalone tools
(`cmd/smoke`, a solo agent) found their own household via `identity.SelfHousehold` — a single key
acting as root+member+device — and self-adopt on a fresh carrier.

Verified end-to-end against a live cairnd: a fresh carrier logs *awaiting founding* and refuses;
`cmd/smoke` publishes its self-attestation → carrier logs *adopted … now ENFORCING* and the event
round-trips and verifies; on restart the carrier loads the persisted root and stays enforcing.
`core/gate_test.go` pins the rejections (pre-founding, revoked, foreign household, unknown link) that
can't be driven without a browser here.

### Two-tier membership: spaces grant discovery, rooms grant access — decided 2026-07-18 (Phase 4)

Membership was a single tier: a signed `MEMBER_ADD` that HPKE-wraps the room key. You saw only
rooms you were admitted to, so a newcomer landed on an empty sidebar and could not learn that any
room existed to ask into (a recorded Phase-4 gap). Spaces existed as a policy record but conferred
nothing.

**Decision: spaces have their own membership, and it is the discovery tier.**

- `SPACE_MEMBER_ADD` (enum 56) admits a member root to a **space**. It **wraps no key** — it grants
  the right to *see* the space's discoverable rooms and nothing more. Cheap to give, and it leaks
  nothing about room contents. Folded into `space_members`, keyed on the member root like room
  membership, so a member's spaces follow them across devices.
- `ListRooms` (now `core.VisibleRooms`) returns two tiers: rooms a `MEMBER_ADD` admitted you to
  (`joined=true`, readable) **plus** the discoverable rooms of every space you belong to
  (`joined=false`, visible but locked). The client renders unjoined rooms with a lock.
- **Rooms carry a `visibility`** (`discoverable` | `hidden`, default discoverable). A `hidden` room
  is returned only to someone a `MEMBER_ADD` actually admitted — space membership never reveals it.
  This is what lets a DM or a private room live inside the household space without being listed to
  everyone.
- **Room membership is NOT a discovery grant.** Being added to one room reveals that room and its
  space, but not sibling rooms — discovery is a separate, deliberate `SPACE_MEMBER_ADD`. Founding a
  space makes the founder its first space member; inviting a household member grants them space
  membership, so they arrive with the household's rooms visible instead of a blank sidebar.
- **Getting into a discovered room: `ROOM_JOIN_REQUEST` (enum 57).** A discoverer signs an ask into
  the room DAG carrying their member root; an existing member answers it with the ordinary
  add-by-key (the only act that can wrap the key). Cleartext epoch 0 — the requester holds no key.
  "Pending" is derived (request minus roster), so a fulfilled request needs no separate record.

**Why not fold space membership into room membership / auto-reveal siblings.** Auto-revealing every
room in a space to anyone in one room would make a household's room list leak through a single
shared channel. Keeping discovery an explicit grant preserves the property that *what you can see is
always the result of a signed act naming you* — the same principle that killed the `data.ts` phantom
rooms and `ensureCurrentKey`.

Both new events are cleartext epoch-0 room-state events (like `ROOM_CREATE` / `MEMBER_ADD`): a node
that is not yet a member must still be able to fold them. `core/rooms_test.go` pins the two-tier
matrix — founder sees all, a space-only member discovers just the discoverable rooms, a room-only
member sees no siblings, a stranger sees nothing.

**Amendment (later 2026-07-18) — spaces are first-class and multiple; channels live inside one.**
The initial cut kept exactly one space per household, id derived from the household root
(`householdSpaceId`), auto-created as a side effect of making the first room. That was an
anti-accidental-forking measure from when a room silently minted its space. Per
`claude-design/cairn-spaces.jsx` a space is a *named policy boundary* and a household may hold several
("Family", "Ops"), so:

- Space creation is now a **deliberate act** (`createSpace` → `SPACE_CREATE` + `SPACE_MEMBER_ADD(self,
  admin)`), and a space id is **unique per creation** (`newSpaceId`), not derived from the household.
  Convergence still holds because everyone folds the *same* signed `SPACE_CREATE` — the derived id was
  only ever a way to make independent members compute the same value, which explicit creation makes
  unnecessary.
- **A channel cannot exist without a space.** `createRoom` requires an active space and no longer
  auto-creates one; a brand-new household shows an empty rail whose only affordance is "Create a
  space". This reverses the "found the household space on demand" behaviour above — founding no longer
  implies a space.
- The anti-forking concern is preserved in spirit: forking a space is now a *deliberate* act, not an
  accident of two members each creating a room, so nothing is silently duplicated.

### Typed identity-log objects and approval artifacts — decided 2026-07-18

Every identity-log object (`identity/`) and portable approval artifact (`approval/`) now carries
a **`type` field inside its signed bytes**.

**Why.** Both sets of CBOR objects previously had no type tag, and the structs share field names
— a `SessionDelegation` partially decodes as a `DeviceDelegation`, a `Deny` as a `Grant`. The
carrier discriminated by trying each shape and keeping whichever *verified*. That worked only
because canonically re-encoding a decoded struct produces different bytes when field sets
differ — a property of the current layout, not a guarantee. One added field could make a
signature transfer between types.

**What it buys:**

- **Deterministic parsing.** Read the tag, dispatch. No speculative decoding, no load-bearing
  attempt ordering, no O(n) verify attempts as object types grow (Phase 5 adds WebAuthn
  envelopes).
- **Domain separation.** The tag is inside the signature, so cross-type confusion requires
  forging Ed25519 rather than finding a canonical-encoding collision.

**Rules:** `Sign` stamps the canonical tag; `signingBytes` FORCES it (so nobody signs an object
wearing another type's tag); verification checks the stored tag **before** the signature, so a
mislabelled object is rejected on the tag. Untagged objects — anything predating this change —
no longer verify.

**Highest-stakes case:** an `approval.Grant` is designed to verify *standalone, outside Cairn,
with no room key and no event envelope* (Phase 2 exit). A broker holding a bare blob has no
context to tell a grant from a deny. `approval/type_test.go` pins that a signed **Deny** can
never verify as a **Grant** — otherwise a broker could mint a credential on a refusal.

**Cost, accepted:** a wire-format break. All golden conformance vectors regenerated on both
sides. Done now precisely because dev-phase policy allows it (no migrations, wipe the DB); after
the real-users switch this would be a versioned migration over every stored identity object and
every previously-issued portable grant.

Kept `identity/verify_test.go`'s cross-type matrix afterwards as a regression net — it now
guards a structural property rather than an incidental one.

### CBOR floats — fixed 2026-07-18 (was silent data corruption)

The browser's CBOR encoder did `BigInt(Math.trunc(v))`: **every non-integer was silently
truncated to an integer**, and the decoder threw outright on major-type-7 floats.

Consequences, both live before this was found:

- Every inlay payload the browser sent had its fractions destroyed. A poll `share: 0.333`
  encoded as `0`; every `progress_fraction` was `0`; sensor readings truncated. They rendered
  as zeros rather than errors, so nothing looked broken — the `progress_fraction` role was
  meaningless on the wire since Phase 2.
- Any payload authored by a Go client containing a fraction was **undecodable**, so the whole
  event silently failed to render.

Now: shortest-form IEEE-754 encoding (f16 → f32 → f64) matching Go's `cbor.CoreDetEncOptions`
(`ShortestFloat16`), and decoding for all three widths. Asserted against Go golden vectors
(`0.66 → fb3fe51eb851eb851f`, `24.6 → fb403899999999999a`, nested map byte-identical).

**Known limit:** JS cannot distinguish `640.0` from `640`, so a whole number always encodes as
a CBOR int here while Go's `float64(640)` emits a float. Values round-trip correctly; only the
byte form differs. Safe because inlay *bindings* are never hashed — `decl_cid` covers the
DECLARATION, whose numbers are integers. Do not rely on byte-identical encoding of
whole-number floats across the two implementations.

---

## ⚠️ Deviations — where the build knowingly differs from `plan.md` / the vision

Read this before trusting `plan.md` on these points. Each is deliberate, not an oversight.

- **Inlays are AGENT-DEFINABLE; the standard library was the wrong shape.** `plan.md` Phase 2
  specified standard-library cards (poll, approval, task_list, agent_panel) shipped in the client,
  with novel declarations as a per-room default-deny exception. Built that way, the exit criterion
  passed on `greenhouse_bench` — but it only ever proved the RENDERER generalises. There was no way
  to transport a declaration, so an agent could reference only UI the client already compiled in,
  which caps agent UI at whatever we anticipated.
  Reversed: `inlay_decl` (event type 34) publishes a declaration into the room, receivers learn it by
  **verified** BLAKE3 hash, and it renders under **trust-by-author** — an agent that is a room member
  composes freely. The shipped set is now `approval_prompt` **alone**, kept pinned because a spoofable
  approval prompt is a phishing surface and that flow must stay specific and trackable. poll,
  task_list, agent_panel and greenhouse_bench moved to `cmd/agent`, which publishes them at runtime
  like any other agent — so the demo now exercises the protocol rather than the client's registry.
  Consequence to accept: a declaration renders only once it has arrived. On a partition an instance
  shows its `text` line until the declaration syncs, and an agent removed from a room leaves its
  cards degraded (no author left to trust). Shipped declarations never had that failure mode; it is
  the price of not deciding in advance what UI an agent is allowed to have.
  Second consequence: `decl_cid` byte-identity across languages is now load-bearing, since Go
  publishes and the browser verifies. Nested-map CBOR ordering was previously **untested** — the
  event vectors are arrays only — so a declaration vector was added to both
  `event/conformance_test.go` and `webapp/scripts/conformance.ts`.

- **`blobs/` does NOT talk to `iroh-store` yet — it ships a local filesystem backend.**
  `plan.md` §2/Phase 2 specifies `blobs/` as an **iroh-store gRPC client** (content addressed
  by BLAKE3, verified resumable range reads, pinning). No `iroh-store` daemon exists in this
  environment, so building against it would be unrunnable and untestable. Instead `blobs/`
  defines a **`Backend` interface** (`Put`/`Get`/`GetRange`/`Has`/`Pin`) with a
  **`blobs/local`** filesystem implementation for development, and `cairnd` exposes a blob
  gateway over HTTP so the browser has somewhere to put bytes.
  - **What this preserves:** content addressing is still **BLAKE3 over the *encrypted* bytes**,
    so a backend never sees plaintext; the `file_ref` envelope, per-file key wrapping, range
    reads, and the honest retrieval states are all real and exercised.
  - **What it defers:** the actual iroh data plane — peer-to-peer fetch, verified resumable
    streaming from multiple providers, real pinning semantics.
  - **Migration path:** add `blobs/iroh` implementing the same `Backend` and switch the
    backend in `core.Setup()`. Nothing above the interface changes. **The interface is the
    contract; the local backend is the placeholder.**
  - Mesh still never carries file bytes — envelope only. That rule is independent of backend.

- **The capability broker is not built here at all** — it is an *external* component (see the
  correction under "Decided" below). Cairn produces the human-signed grant artifact and stops.
  `plan.md` originally listed a `broker/` package inside Cairn; that was wrong and is corrected.

## Open — questioned / proposed, NOT yet decided

- **SQLite driver:** `modernc.org/sqlite` (pure-Go, no cgo) is my recommendation for clean
  mobile cross-compile. Not decided.
- **Wails3 topology:** does the native app embed the full Go `core` as an on-device node, or act as a
  thin client to `cairnd`? Open.
- **Video phasing:** listed as Phase 6 in `plan.md`, but it's a separate component in the vision. Open.
- **Passkey signature envelope:** does `approval_grant` carry the raw WebAuthn envelope
  (`clientDataJSON || authenticatorData`) or a gesture-gated session-key signature? Open; lock before
  Phase 5.

---

## Reference — how the vision says it works (facts, not our decisions)

### File serving (`systems/data-plane/README.md`, `protocol.md` §Files)
- Content is named by a **BLAKE3 hash** on the iroh data plane — not served from a location.
- Chat carries a tiny **`file_ref` envelope** `{ hash, wrapped_key, mime, size, thumb_hash? }`; the
  bytes ride the data plane separately (any transport).
- Sender encrypts (per-file AES key) → adds to `iroh-store` → BLAKE3 hash → pins.
- Retrieval is a separate transport problem: LAN/WAN verified range fetch → BLE if a peer pins →
  **`pending`** if no fat link. Mesh never carries file bytes, only the envelope.
- BLAKE3 tree → verified, resumable range reads → thumbnail-first, resumable `downloading`, media seek.
- *Design implication (proposal):* the mockup says "CID"/`image_cid`; the accurate term is a BLAKE3
  hash / `file_ref` — keep the role name if desired, but say *hash*, not *IPFS*, in copy.

### Passkeys (`systems/identity/web.md`)
- Passkey = the **browser device key** (not a new tier): household root → member root → passkey →
  session key.
- Two-tier signing: passkey ceremony (biometric) issues the session key and signs capability grants
  (`approval_grant`, `member_add`, `room_key_rotate`, install); the session key signs chat-rate events
  with no gesture.
- No login screen; session start = one gesture mints the session key; no silent renewal.
- RP-ID constraint: needs a real registrable domain; `.lan`/`.local`/mDNS/raw-IP fail. Fix: own a
  domain + DNS-01 Let's Encrypt, or the native wrapper, or degrade to WebCrypto-only.
- Syncable OK for daily device keys; member-root-adjacent device-bound only; agents/services don't use
  passkeys.
- *Design implication (proposal):* add a biometric beat to the approval inlay + capability-bound inlay
  actions.

---

## Design mockup status — review of origin `02a675c` "iterated on the design" (2026-07-18)

The designer built from the earlier handoff (dropped from the repo by a force-push; guidance now lives
inline in the mockup file headers + `plan.md`).

**Done:** §A inlay primitives + novel greenhouse card (loading→updating→error→text-fallback) + widget
placeholder (`cairn-primitives.jsx`); §B onboarding/pair/recovery/parent (`cairn-settings.jsx`); §C
settings — identity & devices, notifications + wake matrix, transports + link-radio wizard, appearance
+ density (`cairn-settings.jsx`); §D Space admit-policy + peer-household join (`cairn-spaces.jsx`).

**Remaining:** §E video calls + incoming-call surface + vidmail; §F file/image message card + composer
chips + retrieval states (the `image_cid` primitive exists; the card + states don't); §G agent info
card + home-room link + capability-policy chips (`auto`/`human-gated`/`forbidden`) + `task_update`/
`notify` timeline events; §H edit-history + admin-delete tombstone + threads view; §I `/unmute` + a11y
sweep (density done).

---

## Repo / git ops notes

- Design repo **`origin/main` gets force-pushed by the designer** — `git fetch` (reset if needed)
  before pushing.
- Git has no configured identity; commit as **`Aaron Ogle <aaron@geekgonecrazy.com>`** (matches the
  initial commit). **No `Co-Authored-By` trailer.**

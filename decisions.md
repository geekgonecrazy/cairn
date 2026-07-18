# Cairn — decisions & context log

Durable record of the Cairn planning conversations. **Sections are labelled by status** — what the
user actually *decided*, what's still *open*, and *reference* facts pulled from the vision docs.
Nothing in "Open" or "Reference" is a settled decision.

Companion to [`plan.md`](./plan.md) (the build plan) and the design mockup in
[`claude-design/`](./claude-design). Architecture source of truth: `/root/code/vision/systems/cairn/`
(`protocol.md`, `inlay.md`, `ux.md`, `README.md`), `systems/identity/web.md`,
`systems/data-plane/README.md`.

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

Closes the open question carried in `plan.md` §5 and `PROTOCOL.md` §298. Implemented in
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

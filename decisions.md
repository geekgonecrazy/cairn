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

---

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

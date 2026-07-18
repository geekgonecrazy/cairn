# Cairn — decisions & context log

Durable record of decisions and rationale from planning conversations, so context isn't lost.
Companion to [`plan.md`](./plan.md) (the build plan) and the design mockup in
[`claude-design/`](./claude-design). Architecture source of truth:
`/root/code/vision/systems/cairn/` (`protocol.md`, `inlay.md`, `ux.md`, `README.md`),
`systems/identity/web.md`, `systems/data-plane/README.md`.

---

## Sources of truth

- **UI / UX** — the `claude-design/` mockup (Svelte target). The React mockup is a *picture, not
  a blueprint*: port look/behavior, not structure.
- **Architecture / protocol** — the vision repo at `/root/code/vision`.
- **Build plan** — `plan.md`. **Stack decisions** — `plan.md` §1 (Svelte+Vite PWA · Go `cairnd` ·
  ConnectRPC · SQLite via `modernc.org/sqlite` · iroh-blobs · Wails3 · Ed25519 + passkeys).

---

## D1 — No NATS / JetStream in Cairn core *(rejected)*

- **JetStream duplicates the signed event DAG** — and weaker (no signatures, no causal parents,
  no room-key E2EE). It would create a second, competing source of truth. No.
- **Realtime WS fan-out** = a small in-process Go-channel hub at household scale; NATS is overkill.
- **"No central bus" is an anti-goal.** Cairn rooms (the DAG) *are* the coordination substrate —
  agents post signed events into rooms precisely so there's no separate bus. Network-layer pub/sub
  is already assigned to **iroh-gossip / iroh-blobs dead-drop**.
- **Mesh outbox** is a *cursor over the DAG* (which events each peer/transport hasn't acked), not a
  separate durable queue.
- **Where NATS does belong:** the **home-automation device bus** (NATS speaking MQTT at the edge) —
  already decided in the vision. If Cairn agents need `device_*` events, `cairnd`/the agent workload
  **subscribes to that existing household NATS** at the seam (Phase 2 / home-automation), not
  internally.
- **Optional convenience only:** an embedded **in-memory NATS (no JetStream)** as the WS fan-out hub
  if the team prefers subjects over channels — must stay **in-process/in-memory**, and **never** the
  source of truth or in the trust path.

## D2 — File serving *(informs design §F)*

- Files aren't served from a location — **content is named by a BLAKE3 hash** on the iroh data plane.
- Chat carries a tiny **`file_ref` envelope** `{ hash, wrapped_key, mime, size, thumb_hash? }`; the
  **bytes ride the data plane separately** (any transport).
- Sender encrypts with a per-file AES key → adds to `iroh-store` → BLAKE3 hash → pins.
- **Retrieval is a separate transport problem:** LAN/WAN verified range fetch → BLE if a peer in
  range pins the bytes → **`pending`** if no fat link. **Mesh never carries file bytes — only the
  envelope.**
- BLAKE3 is a *tree* hash → **verified, resumable range reads** → thumbnail-first, resumable
  `downloading`, media seek (HTTP range on 90 GB MP4s, no transcoding).
- **Copy-edit:** mockup says "CID"/`image_cid`; the accurate term is a **BLAKE3 hash / `file_ref`**
  (vision moved IPFS→iroh). Keep the role name if desired, but say *hash*, not *IPFS*, in copy.

## D3 — Passkeys *(from `identity/web.md`)*

- **Passkey = the browser device key** (not a new tier). Chain: household root → member root →
  **passkey (device key)** → session key.
- **Two-tier signing:** the **passkey ceremony (biometric)** issues the session key and signs
  **capability grants** (`approval_grant`, `member_add`, `room_key_rotate`, component-install); the
  **session key** signs chat-rate events (`chat`, `presence`, `reaction`, `inlay_update`,
  `task_update`, read-only `interaction`) with no gesture.
- **No login screen.** Session start = one gesture mints the session key; no silent renewal
  (re-prompt on expiry).
- **Capability-bound approve = biometric gesture** — matches the broker model (the right friction).
  → **Add a biometric beat** to the approval inlay + capability-bound inlay actions in the UI.
- **RP-ID constraint (the real gotcha):** passkeys need a **real registrable domain**; `.lan` /
  `.local` / mDNS / raw-IP **fail**. Fix: **own a domain + DNS-01 Let's Encrypt** (offline-usable,
  renews every 90 days, serving is local), or the native wrapper, or degrade to WebCrypto-only.
- **Syncable vs device-bound:** daily device keys syncable is fine; member-root-adjacent
  device-bound only; **agents/services don't use passkeys** (workload keystore on the box).
- Passkey **resolves the iOS Safari eviction concern** (passkey isn't in browser storage; only the
  cached delegation/session key is evictable, and that's recoverable).
- **Open tension to lock before Phase 5:** does `approval_grant` carry the raw **WebAuthn** signature
  envelope (`clientDataJSON || authenticatorData`, which verifiers must accept) or a gesture-gated
  session-key signature?

## D4 — Stack sign-offs still open *(from `plan.md`)*

- **ConnectRPC** vs the vision's literal "gRPC + grpc-web gateway" (Connect subsumes grpc-web).
- **Wails3 embeds the full Go `core`** as an on-device node (durable local DAG) vs a thin client to
  `cairnd`.
- **Video is Phase 6** here, though it's a separate component in the vision.

---

## Design mockup status — review of origin `02a675c` "iterated on the design" (2026-07-18)

The designer built from the earlier handoff (now dropped from the repo by a force-push; guidance
lives inline in the mockup file headers + `plan.md`).

**Done:**
- **§A** inlay primitive vocabulary + a novel greenhouse card (loading → updating → error →
  text-fallback) + widget placeholder — `cairn-primitives.jsx`.
- **§B** onboarding / pair / recovery / parent-setup — `cairn-settings.jsx`.
- **§C** settings: identity & devices, notifications + wake matrix, transports + link-radio wizard,
  appearance + density — `cairn-settings.jsx`.
- **§D** Space admit-policy + peer-household join (3 intake → origin-fingerprint review →
  cross-household flip) — `cairn-spaces.jsx`.

**Remaining:**
- **§E** video calls, incoming-call surface, vidmail (calls still voice-only).
- **§F** file/image message card + composer attachment chips + retrieval states (the `image_cid`
  *primitive* exists; the message-level card + states don't).
- **§G** agent info card + home-room link + **capability-policy chips** (`auto`/`human-gated`/
  `forbidden`) + `task_update`/`notify` timeline events.
- **§H** edit-history view + admin-delete tombstone + threads view.
- **§I** `/unmute` + a11y sweep (density is done).

---

## Repo / git ops notes

- Design repo **`origin/main` (github.com/geekgonecrazy/cairn) gets force-pushed by the designer** —
  `git fetch` (and reset if needed) **before pushing** to avoid divergence surprises.
- Git has no identity configured; use the existing repo author **`Aaron Ogle
  <aaron@geekgonecrazy.com>`** (matches the initial commit). **No `Co-Authored-By` trailer.**

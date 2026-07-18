# Cairn — build plan

A phased plan to build **Cairn**: a local-first, E2EE, human + agent comms client on a
custom Go protocol (per-room signed event DAG, Ed25519 identities, pluggable transports).

**Two sources of truth:**
- **UI / UX** → the design mockup in [`claude-design/`](./claude-design) (Svelte target). The
  React mockup is a *picture, not a blueprint* — port the look/behavior, not the structure.
- **Architecture / protocol** → the vision docs at `/root/code/vision/systems/cairn/`
  (`protocol.md`, `inlay.md`, `identity/web.md`) + `systems/data-plane/README.md`.

---

## 1. Stack decisions

| Layer | Choice | Notes |
|---|---|---|
| **Frontend** | **Svelte + Vite**, PWA, **SPA mode** | One frontend serves both the browser PWA (Capsule-hosted) and the Wails3 native app. Service Worker + OPFS for offline. SPA base path set for Wails (`base: "/__hub/"`). |
| **Backend** | **Go** single binary (`cairnd`), a Capsule workload | gRPC + gRPC-Web + **WebSocket only** for the realtime event stream. |
| **RPC** | **ConnectRPC** (buf + `connect-go` + `connect-es`) | One proto → Go server + TS client + browser-native gRPC-Web, no separate gateway. Realtime via WS `RealtimeService.Subscribe` (per vision) or Connect server-stream. |
| **DB** | **SQLite**, everywhere a Go runtime exists (server + on-device native node) | Use **`modernc.org/sqlite`** (pure-Go, **no cgo**) so it cross-compiles cleanly, incl. mobile. Browser PWA uses **OPFS/IndexedDB** (no SQLite in-browser). |
| **Data plane** | **iroh-blobs** via a shared **`iroh-store`** node (Rust daemon) reached over local gRPC | Content = **BLAKE3 hash**; verified, resumable range reads. Browser reaches a Capsule-hosted `iroh-store` gateway; native embeds iroh via FFI (later). Files = `file_ref` envelope on chat, bytes on the data plane. |
| **Mobile / desktop** | **Wails3** (Go + Svelte) | Wraps the same Svelte frontend; **embeds `core` as an on-device Cairn node** (durable SQLite storage, BLE, authenticator). Follow the iOS gist notes in §6. |
| **Identity** | Ed25519 delegation chain; **WebAuthn passkeys** as the browser device key | Chain: household root → member root → device key (passkey on web) → session key. |
| **Crypto** | **No inventing** — Ed25519 (sign), AES-GCM (room E2EE), BLAKE3 (content), WebAuthn (passkey), HPKE/wrap for room-key handoff | Established primitives only. |

---

## 2. Repo layout (monorepo)

```
cairn/
  proto/               # protobuf wire schema + Connect service defs — THE contract
  core/                # Go shared libraries (used by cairnd AND the Wails3 node)
    identity/          #   Ed25519 chain: root → member → device → session; delegations
    event/             #   Event envelope, per-room signed DAG, causal parents, tiebreak
    room/              #   per-room E2EE (room key, AES-GCM), key rotation, membership
    store/             #   SQLite store (modernc): events, rooms, members, keys, last-seen
    transport/         #   plugin iface + impls: lan, mesh (LoRa), ble, iroh
    broker/            #   pure-verifier capability broker + consumed-id cache
    blobs/             #   iroh-store gRPC client (add/get/get-range/pin/has/export)
  cmd/
    cairnd/            # Go server binary (Capsule workload): Connect API + WS realtime
  web/                 # Svelte frontend (PWA + shared UI) — ports claude-design/
    src/lib/design/    #   design system: CSS vars, primitives, chips, buttons (from mockup)
    src/lib/inlay/     #   declared-inlay role renderer + standard-library cards
    src/lib/net/       #   Connect client, WS subscribe, local store (OPFS/IDB)
  native/              # Wails3 wrapper: embeds core as the on-device node + platform APIs
  claude-design/       # existing mockup — UI reference, not shipped
  plan.md              # this file
```

**Define the Phase-3 demonstration criteria before Phase 1** (vision requirement): e.g.
*"two devices converge a 24h, N-event history across LAN↔mesh; broker approval end-to-end;
no crypto regressions."* Put it in `proto/` or a `MILESTONES.md`.

---

## 3. Phases

Each phase has **deliverables** and an **exit criterion**. Phases 1–5 map to the vision's
phased plan; 0 and 6 bracket it.

### Phase 0 — Foundations
**Goal:** the contract and scaffolding everything else builds on.
- [ ] `proto/`: `Event` envelope + **all event types up front** — `chat`, `presence`,
  `reaction`, `edit`, `delete`, `file_ref`, `member_add/remove`, `room_key_rotate`,
  `device_delegation/revoke`, `task_*`, `approval_request/grant/deny`, `credential_minted`,
  `inlay`, `inlay_update`, `interaction`, `signaling_offer/answer/ice`, `call_ring`,
  `call_bye`, `space_create/update`. (Reserve the ones later phases implement.)
- [ ] Connect service defs: `RoomService`, `RealtimeService.Subscribe` (WS), `BrokerService`.
- [ ] `core/identity`: Ed25519 keygen, delegation-chain sign/verify (root→member→device→session).
- [ ] `core/store`: SQLite schema + migrations (`modernc.org/sqlite`).
- [ ] `web/`: Svelte+Vite PWA scaffold, SPA base path, port the design system (CSS vars,
  `Icon`, primitives, chips, buttons, modal shell) from the mockup into Svelte components.
- [ ] `MILESTONES.md` with the Phase-3 demonstration criteria.

**Exit:** a signed `Event` round-trips proto ↔ Go ↔ TS; chain verifies; Svelte shell renders
an empty room with the design system.

### Phase 1 — MVP: LAN chat + verified history  *(vision Phase 1)*
**Goal:** the "in-house on Wi-Fi" baseline.
- [ ] `core/event`: per-room signed DAG (causal parents, tiebreak = lower `event_id` hash),
  local-first write, incremental sync.
- [ ] `core/room`: per-room key, AES-GCM payloads, `member_*`, `room_key_rotate`
  (new member gets current key; **pre-join history opaque** — state the rule).
- [ ] `core/transport/lan` (gRPC) + `cmd/cairnd` (Connect API + WS realtime subscribe).
- [ ] `web`: Spaces / rooms / DMs, composer, message list with **honest states**
  (`sending → sent → queued (no route) → delivered (path unknown)`), reactions, reply,
  quote, edit, delete (tombstone), presence. Local DAG cache in OPFS/IDB + session key.
- [ ] Route (accept, no UI): `signaling_*`, `call_ring`, `call_bye`.

**Exit:** two browsers on one LAN converge a verified, signed history; server restart loses
no history; message states reflect real delivery.

### Phase 2 — Agents native + files + inlays  *(vision Phase 2)*
**Goal:** structured agent interaction and content.
- [ ] `core/broker`: pure verifier — verifies `approval_request` + `approval_grant` pair +
  policy + consumed-id cache → `credential_minted`. `task_*` / `approval_*` wired.
- [ ] `core/blobs`: `iroh-store` gRPC client; `file_ref` = encrypt (per-file AES key) → add →
  BLAKE3 hash → pin → envelope `{hash, wrapped_key, mime, size, thumb_hash?}`.
- [ ] `web/inlay`: **declared-inlay role renderer** — the primitive vocabulary (`text`,
  `number`, `progress_fraction`, `status_enum`, `timestamp`, `image_cid`, `series`,
  `action_ref`, `input`/`select`, `record`/`list`/`group`/`inlay_ref`) + standard-library
  cards (poll, approval, task_list, agent_panel) + **text fallback** + **widget placeholder**.
  Port from `claude-design/cairn-primitives.jsx`.
- [ ] `web`: agent panel, approval inlay + broker flow, capabilities card (+ **policy chip**
  `auto`/`human-gated`/`forbidden`), signed audit log, **file/image cards with retrieval
  states** (`available` / `pending — no fat link` / `downloading` / `broken`), composer
  attachment chips, **per-room declaration allowlist** (default-deny admin surface).

**Exit:** agent `approval_request` → human approve → broker mints credential (end-to-end);
a novel declared inlay renders from primitives + degrades to its text line; files send/receive
with honest retrieval states.

### Phase 3 — Meshtastic transport + **demonstration**  *(vision Phase 3)*
**Goal:** the bridge-tax payoff, in running code.
- [ ] `core/transport`: generalize the plugin iface (`Available()`, framing); `mesh` (LoRa)
  via serial/MQTT bridge; proto `Event` framed for the ~200 B LoRa MTU; per-event-type
  routing defaults (chatty types off mesh); **mesh queue: ordering + dedup across gaps**.
- [ ] Auto path selection LAN ↔ mesh; `file_ref` **envelope only** over mesh (never bytes).
- [ ] `web`: transport mode switcher (auto/home/field/mesh-only), per-message hint,
  "via mesh" / "pending — no route" surfacing, transports settings + **link-radio wizard**
  (from `claude-design/cairn-settings.jsx`).

**Exit (the demonstration milestone):** two devices converge a 24h history across LAN↔mesh,
broker approval works over mesh, no crypto regressions vs. Phase 1.

### Phase 4 — Multi-device delegations + identity/trust surfaces  *(vision Phase 4)*
**Goal:** many devices = one identity; Spaces as policy.
- [ ] `core/identity`: **self-DAG** for `device_delegation` / `device_revoke`; **household-root
  bootstrap** + member provisioning; **24-word recovery** (member/household root, in no
  authenticator).
- [ ] QR **device pairing** (new device generates key → QR → trusted device signs delegation +
  wraps room keys).
- [ ] `web`: onboarding / pairing / recovery / parent-sets-up-kid (from
  `claude-design/cairn-settings.jsx`); identity & devices settings (paired list, revoke);
  **Space settings + admit-policy** (kind + origin) and **peer-household join** (paste key /
  QR / signed invite → origin-fingerprint review → cross-household flip) from
  `claude-design/cairn-spaces.jsx`; notifications settings (cloud push off by default, wake matrix).

**Exit:** pair a new device by QR; revoke a device; Space admit-policy enforced on join;
recovery flow gated and unskippable.

### Phase 5 — Native wrapper (Wails3) + BLE + passkeys  *(vision Phase 5)*
**Goal:** durable on-device node, proximity transport, biometric authority.
- [ ] `native/`: **Wails3** app wrapping `web/`, **embedding `core`** as an on-device node with
  **durable SQLite** storage. iOS specifics in §6.
- [ ] `core/transport/ble`: **presence advertising** (GAP: pubkey + reachability) + **GATT data
  exchange** (proto `Event` framed for BLE MTU, bitchat-class).
- [ ] **Passkeys** (`identity/web.md`): passkey = browser device key; **two-tier signing** —
  one passkey ceremony issues the session key; **passkey gesture on capability grants**
  (`approval_grant`, `member_add`, `room_key_rotate`, component-install); RP-ID via an owned
  domain + **DNS-01 Let's Encrypt** cert (or native wrapper); syncable-vs-device-bound policy.
- [ ] `web`: **biometric beat** on capability-bound actions (approval inlay, cap-actions).

**Exit:** native iOS app (simulator) with durable storage + passkey pairing; BLE presence
between two devices; approving a capability triggers a biometric ceremony.

### Phase 6 — Video / calls / vidmail  *(uses Phase-1 reserved signaling)*
**Goal:** live and async video, substrate-native. Tracks the vision **video** component.
- [ ] Pion/WebRTC over the reserved `signaling_*` / `call_ring` / `call_bye` events.
- [ ] `web`: voice + **video call** surfaces, **incoming-call** surface (aggressive all-transport
  broadcast, locked), watch party (from `claude-design/cairn-video.jsx`), **vidmail**
  (`file_ref` recorded video with retrieval states).

**Exit:** 1:1 video call over substrate signaling; vidmail send/receive.

---

## 4. Cross-cutting workstreams (run through all phases)

- **Wire schema first.** `proto/` is the contract; regenerate Go + TS from it; never hand-edit
  generated code.
- **Crypto discipline.** Established primitives only; verifiers must accept the **WebAuthn
  signature envelope** (`clientDataJSON || authenticatorData`) for passkey-signed grants.
- **Honest states, always.** No fake "delivered", no infinite spinner; `pending — no route` /
  `pending — no fat link` are real states.
- **Design-system parity.** Light/dark + compact/comfortable density + a11y (SR labels,
  keyboard nav) as a standing requirement, not a phase.
- **Testing.** DAG convergence tests (partition/merge), crypto conformance, and the Phase-3
  demonstration harness.

---

## 5. Open questions to resolve before the phase that needs them

From `protocol.md` (carry these forward):
- **Household-root bootstrap & recovery** shape (apex key above member roots) — needed **Phase 4**.
- **Tiebreak rule** (lower `event_id` hash) composes with parent-count + timestamp — **Phase 1**.
- **History recovery after long partition** (incremental sync since common ancestor, bounded) — **Phase 3**.
- **Room-key rotation on membership change** — state the pre-join-opacity rule — **Phase 1**.
- **`prf` extension** feasibility (derive session key from passkey, kill the in-page key) — **Phase 5**.
- **RP-ID for the cross-household browser case** — **Phase 4+ federation**.
- Passkey doc tension: does `approval_grant` carry the raw WebAuthn passkey signature or a
  gesture-gated session-key signature? Lock before **Phase 5** broker/verifier work.

---

## 6. Wails3 / iOS notes (from the referenced gist)

- **Node ≥ 20.19** (Node 18 breaks the Vite/rolldown build).
- Full **Xcode** (not just CLI tools); `wails3 doctor` clean; iOS Simulator runtime installed.
- `application.New(application.Options{Services: [...]})` (V3), `app.Event.Emit()`, bindings at
  `frontend/bindings/<module-path>/` — **fix the template's hardcoded `./bindings/changeme`**.
- Frontend `base: "/__hub/"` in `vite.config.js` (Wails claims `/wails/`).
- iOS: `Window.Current()` is nil (use package-level window globals); `WebviewWindowOptions.JS`
  injection is a no-op (use the asset proxy layer); safe-area insets are zero in the webview
  (recolor notch/status bar from Go via `SetChrome()`).
- Build: `wails3 task ios:package` (standalone) → `ios:deploy-simulator` → `ios:logs`.
  **Not** `ios:run` (needs a dev server → blank screen). Simulator bundle: ad-hoc sign
  (`CODESIGN_IDENTITY="-"`), no entitlements.
- Fixed platform bugs to watch: ReverseProxy drops POST/PUT bodies (set `req.ContentLength = -1`
  when zero-with-body).
- **Unproven:** device (non-simulator) validation; **mDNS discovery** needs the
  `com.apple.developer.networking.multicast` entitlement (unapproved) or a Bonjour cgo bridge —
  **relevant to `core/transport/lan` on iOS**; plan a fallback (server-mediated / iroh) there.
- Info.plist / entitlements need `NSLocalNetworkUsageDescription` + multicast entitlement filled in.

---

## 7. Suggested first steps

1. Stand up `proto/` with the full event enum + Connect defs; generate Go + TS.
2. `core/identity` + `core/event` + `core/store` (SQLite) with unit tests for chain-verify and
   DAG convergence.
3. `cmd/cairnd` LAN + WS; `web/` shell talking to it — hit the **Phase 1 exit** (two browsers,
   one verified history) before widening scope.
4. Write the **Phase-3 demonstration criteria** now, so the bridge-tax payoff is measurable.

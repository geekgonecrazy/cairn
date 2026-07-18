# Cairn — milestones & exit criteria

Per-phase "done" definitions for the plan in [`plan.md`](./plan.md). A phase is not
finished until its exit criterion is demonstrable, not just coded. The **Phase 3
demonstration** is the vision's headline milestone and is defined up front (below), so
the bridge-tax payoff is measurable from day one.

---

## Phase 0 — Foundations

**Exit:** a signed `Event` round-trips proto ↔ Go ↔ TS; the delegation chain verifies;
the Svelte shell renders an empty room with the design system.

- [x] `proto/` full event enum + `CairnService` Connect defs; Go generated to `proto/cairnv1`.
- [x] `identity`: Ed25519 keygen + chain-walk verify (session→device→member→household root),
      with expiry/revoke/tamper/untrusted-root/missing-link tests.
- [x] `event`: canonical det-CBOR content, BLAKE3-256 `event_id`, Ed25519 sig, verify;
      DAG heads; proto round-trip. Parent-order-invariant id.
- [x] `store` + `store/sqlite` (modernc): schema/CheckDb, DAG head maintenance
      (fork/merge/out-of-order), frontier sync diff, identity-log resolver — all tested.
- [x] `cmd/cairnd`: ConnectRPC API + SSE realtime; signed Event sent, stored, re-synced,
      and broadcast end-to-end (see `cmd/smoke`).
- [x] `webapp`: Svelte+Vite PWA scaffold, SPA base `/__hub/`, design system ported
      (OKLCH tokens, Icon set, shell: space rail + room list + room view + composer),
      generated Connect-ES client + SSE, empty room renders; builds + typechecks clean;
      served by cairnd under `/__hub/`.

## Phase 1 — MVP: LAN chat + verified history

**Exit:** two browsers on one LAN converge a verified, signed history; a server restart
loses no history; message states reflect real delivery
(`sending → sent → queued (no route) → delivered (path unknown)`).

- Per-room key + AES-256-GCM payloads; `member_*`; `room_key_rotate`; pre-join history
  opaque (state the rule in UI).
- LAN transport; local-first write; incremental sync (frontier diff) over the wire.
- Composer, message list with honest states, reactions, reply, quote, edit, delete
  (tombstone), presence. Local DAG cache in OPFS/IDB + session key.
- Route (accept, no UI): `signaling_*`, `call_ring`, `call_bye`.

## Phase 2 — Agents native + files + inlays

**Exit:** agent `approval_request` → human approve → broker mints a credential
(end-to-end); a novel declared inlay renders from primitives and degrades to its text
line; files send/receive with honest retrieval states.

## Phase 3 — Meshtastic transport + **THE DEMONSTRATION**

**Exit (headline milestone):** two devices converge a **24-hour, N-event history across
LAN ↔ mesh**; the broker approval flow works **over mesh**; **no crypto regressions vs.
Phase 1** (same conformance vectors pass). File bytes never ride mesh — envelope only.

*Measurable form:* start two nodes, partition them onto LAN and mesh-only respectively,
generate ≥ N events over 24 h (chat + one approval flow), rejoin, and assert: identical
DAG head set, every event verifies, the credential minted over mesh validates, and the
Phase-1 crypto test vectors still pass unchanged.

## Phase 4 — Multi-device delegations + identity/trust surfaces

**Exit:** pair a new device by QR; revoke a device; a Space admit-policy is enforced on
join; the recovery flow is gated and unskippable.

## Phase 5 — Native wrapper (Wails3) + BLE + passkeys

**Exit:** native iOS app (simulator) with durable storage + passkey pairing; BLE
presence between two devices; approving a capability triggers a biometric ceremony.

## Phase 6 — Video / calls / vidmail

**Exit:** a 1:1 video call over the substrate signaling events; vidmail send/receive.

# Cairn — project orientation

A one-page map for contributors. For running it, see [`README.md`](./README.md); for the
architecture in depth, [`docs/`](./docs/README.md).

Cairn is a local-first, end-to-end-encrypted comms client for **humans *and* agents**, built
on a custom Go protocol: a per-room signed event DAG over Ed25519 identities, with pluggable
transports (HTTP today; Meshtastic, BLE, and iroh planned). Every message is a signed event;
rooms are E2EE; identities are Ed25519 delegation chains, not accounts on a server. The same
signed `Event` bytes travel over whatever transport can reach a peer, and the DAG converges to
the same history on every node without a central authority.

The server (`cairnd`) is **convenience, not authority**: it adds history continuity and a blob
gateway, but two devices converge directly, and every event is verifiable on its own. See
[`docs/architecture.md`](./docs/architecture.md) for the node/transport model.

## Architecture at a glance

- **`Event`** — the lingua franca. A protobuf envelope wrapping a CBOR payload encrypted under
  the room key. The *same bytes* on every transport. Content-addressed by BLAKE3-256; signed
  with Ed25519. See `proto/cairn.proto` and [`docs/protocol.md`](./docs/protocol.md).
- **Identity** — three-tier Ed25519 chain: household root → member root → device (a tree; a
  WebAuthn passkey on the web) → session key. Trust is signed attestations in a household
  identity log, never copied keys. See `identity/` and
  [`docs/events-and-e2ee.md`](./docs/events-and-e2ee.md).
- **Room DAG** — append-only signed events with causal `parents`; merge is hash-set union;
  concurrent events tiebreak by lower `event_id`. Sync is a per-peer frontier diff (an outbox
  cursor over the DAG, not a queue). See `event/`, `store/`.
- **Room E2EE** — a per-epoch AES-256-GCM room key, HPKE-wrapped to each member's device keys.
  Join and leave rotate the epoch. See `room/`.
- **Realtime** — SSE (`GET /v1/subscribe`), a plain `text/event-stream` of Events.
- **Crypto** — established primitives only: Ed25519, AES-256-GCM, BLAKE3, X25519-HPKE,
  WebAuthn, deterministic CBOR. No inventing.

## Conventions

Follows the `geekgonecrazy/rfd-tool` + `fidetechsolutions/flockledger` conventions: flat
top-level packages named by concern, **no `internal/`**; a `store` interface with a
`store/sqlite` implementation; a `core` package wired by `core.Setup()` holding unexported
package state; tiny `cmd/<binary>/main.go` entrypoints; the Svelte app in `webapp/`. Module
path `github.com/geekgonecrazy/cairn`.

```
proto/          protobuf wire schema + generated Go (proto/cairnv1) — THE contract
identity/       Ed25519 delegation chain: sign + chain-walk verify; the household identity log
event/          Event envelope: canonical CBOR, BLAKE3 event_id, sign/verify, DAG heads
room/           per-room E2EE (room key, AES-256-GCM), payload schemas, HPKE key handoff
approval/       portable signed capability artifacts (the human's signature)
blobs/          data plane: file_ref envelope + Backend interface (local filesystem impl)
  local/
store/          store.Store interface
  sqlite/       pure-Go (modernc) backend: DAG, identity log, frontier, rooms/spaces
config/         config.Load + package var config.Config
core/           core.Setup(); the write path (SubmitEvent), the chain gate, the fold, the Hub
controllers/    ConnectRPC CairnService handlers + SSE stream + blob gateway
router/         HTTP surface: Connect handler + SSE + static SPA
cmd/cairnd/     server binary: config.Load → core.Setup → router.Start
cmd/cairnctl/   founding + attestation CLI (household words never touch a browser)
cmd/agent/      a headless Go node — proves the protocol is client-agnostic
cmd/smoke/      an end-to-end self-check
webapp/         Svelte + Vite PWA — the claude-design mockup, ported (a byte-parity node port)
docs/           architecture, protocol, crypto/E2EE, plan, decisions, milestones, diagrams
claude-design/  React mockup — UI reference, not shipped
```

## Status

**Phases 0–4 are largely built** — the contract, crypto core, identity chain (offline
household + member roots, a device delegation *tree*, QR pairing, ancestor-only revocation with
cascade), the default-deny chain gate with a founding window, first-class spaces + two-tier
membership, room E2EE with epoch rotation, portable approval artifacts, agent-definable inlays,
and encrypted files with honest retrieval states. The browser is a byte-parity TypeScript port
of the node, guarded by conformance vectors.

**Next** is the node/transport seam (a `transport/` interface + `Node` abstraction, symmetric
node-to-node sync) and Phase 5 (Wails3 on-device node, BLE, passkeys) — the mobile / BLE /
Meshtastic story in [`docs/architecture.md`](./docs/architecture.md). Per-phase exit criteria
are in [`docs/milestones.md`](./docs/milestones.md).

## Dev-phase policy

Until we declare *real users*, the proto, CBOR payloads, and SQLite schema are freely
breakable: edit in place, no versioning, wipe the DB at will, **no migrations**. Backward-compat
begins only at the real-users switch. History will be squashed before going public. See
[`docs/decisions.md`](./docs/decisions.md).

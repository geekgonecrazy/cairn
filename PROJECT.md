# Cairn

A local-first, end-to-end-encrypted comms client for **humans *and* agents**, built
on a custom Go protocol: a per-room signed event DAG over Ed25519 identities, with
pluggable transports (LAN today; Meshtastic, BLE, and iroh later).

## Overview

Cairn is a chat client that keeps working when the internet doesn't. Every message
is a signed event in an append-only, per-room DAG; rooms are end-to-end encrypted;
identities are Ed25519 delegation chains, not accounts on a server. The same signed
`Event` bytes travel over whatever transport can reach a peer — Wi-Fi now, LoRa mesh
or Bluetooth later — and the DAG converges to the same history on every device
without a central authority. Agents are first-class members alongside people, with a
capability-broker approval flow and structured "inlay" UI instead of bot spam.

The server (`cairnd`) is **convenience, not authority**: it adds history continuity,
a broker endpoint, and file-pin coordination, but two devices on a LAN converge
directly, and every event is verifiable on its own.

## Architecture at a glance

- **`Event`** — the lingua franca. A protobuf envelope (routable/typed) wrapping a
  CBOR payload encrypted under the room key. The *same bytes* on every transport.
  Content-addressed by BLAKE3-256; signed with Ed25519. See `proto/cairn.proto`.
- **Identity** — three-tier Ed25519 chain: household root → member root → device key
  (a WebAuthn passkey on the web) → session key. Trust is signed attestations in a
  household identity log, never copied keys. See `identity/`.
- **Room DAG** — append-only signed events with causal `parents`; merge is hash-set
  union; concurrent events tiebreak by lower `event_id`. Sync is a per-peer frontier
  diff (an outbox cursor over the DAG, not a queue). See `event/`, `store/`.
- **Realtime** — SSE (`GET /v1/subscribe`), a plain `text/event-stream` of Events.
- **Crypto** — established primitives only: Ed25519, AES-256-GCM, BLAKE3, X25519-HPKE,
  WebAuthn, deterministic CBOR. No inventing.

The full contract is in **`PROTOCOL.md`**; the phased build plan in **`plan.md`**;
settled decisions and open questions in **`decisions.md`**; per-phase exit criteria in
**`MILESTONES.md`**. The UI source of truth is the mockup in **`claude-design/`**
(a picture, not a blueprint) — ported to Svelte in `webapp/`.

## Repo layout

Follows the `geekgonecrazy/rfd-tool` + `fidetechsolutions/flockledger` conventions:
flat top-level packages named by concern, **no `internal/`**; a `store` interface with
a `store/sqlite` implementation; a `core` package wired by `core.Setup()` holding
unexported package state; tiny `cmd/<binary>/main.go` entrypoints; the Svelte app in
`webapp/`. Module path `github.com/geekgonecrazy/cairn`.

```
proto/          protobuf wire schema + generated Go (proto/cairnv1) — THE contract
identity/       Ed25519 delegation chain: sign + chain-walk verify
event/          Event envelope: canonical CBOR, BLAKE3 event_id, sign/verify, DAG heads
room/           per-room E2EE (room key, AES-GCM), membership, rotation   [Phase 1]
store/          store.Store interface
  sqlite/       pure-Go (modernc) backend: DAG, identity log, frontier
config/         config.Load + package var config.Config
core/           core.Setup(); the write path (SubmitEvent) + realtime Hub
controllers/    ConnectRPC CairnService handlers + SSE stream
router/         HTTP surface: Connect handler + SSE + static SPA
cmd/cairnd/     server binary: config.Load → core.Setup → router.Start
webapp/         Svelte + Vite PWA — the claude-design mockup, ported
claude-design/  React mockup — UI reference, not shipped
```

## Status

**Phase 0 (Foundations)** — the contract + crypto core are in and tested: a signed
`Event` round-trips proto ↔ Go ↔ server; the Ed25519 chain verifies through the store;
the DAG converges (fork/merge/out-of-order) with a frontier sync diff. Next: the Svelte
shell and Phase 1 (LAN chat + verified history). See `MILESTONES.md`.

## Build & run

```sh
buf generate                 # regenerate proto/cairnv1 from proto/cairn.proto
go test ./...                # crypto + DAG convergence tests
go run ./cmd/cairnd          # serve API + SSE on :8099 (sqlite at ./cairn.db)

cd webapp && npm install && npm run gen && npm run dev   # Svelte dev server (proxies to cairnd)
```

## Dev-phase policy

Until we declare *real users*, the proto, CBOR payloads, and SQLite schema are freely
breakable: edit in place, no versioning, wipe the DB at will, **no migrations**.
Backward-compat begins only at the real-users switch. See `decisions.md`.

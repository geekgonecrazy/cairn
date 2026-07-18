# Cairn

A local-first, end-to-end-encrypted comms client for **humans *and* agents**, built on a
custom Go protocol: a per-room signed event DAG over Ed25519 identities, with pluggable
transports (LAN today; Meshtastic, BLE, and iroh later).

Every message is a signed event in an append-only, per-room DAG. Rooms are E2EE. Identities
are Ed25519 delegation chains, not accounts on a server. The server is **convenience, not
authority** — it adds history continuity and a blob gateway, but events are verifiable on
their own and the DAG converges without it.

See [`PROJECT.md`](./PROJECT.md) for the architecture, [`PROTOCOL.md`](./PROTOCOL.md) for the
wire contract, [`plan.md`](./plan.md) for the phased build plan, and
[`decisions.md`](./decisions.md) for settled decisions and **⚠️ known deviations**.

---

## Prerequisites

| | Version | Notes |
|---|---|---|
| **Go** | **1.25+** | `go.mod` targets 1.25.10 |
| **Node** | **20.19+** or **22.12+** | required by Vite 8 |

That's all you need to run it. Generated protobuf code (Go and TypeScript) is **committed**,
so you do *not* need `buf` or the protoc plugins unless you change `proto/cairn.proto` —
see [Regenerating the wire schema](#regenerating-the-wire-schema).

---

## Quick start

Two terminals.

**1 — Backend** (Connect API + SSE + blob gateway on `:8099`):

```sh
git clone https://github.com/geekgonecrazy/cairn.git
cd cairn
go run ./cmd/cairnd
```

**2 — Frontend** (Vite dev server, proxies the API to cairnd):

```sh
cd webapp
npm install          # first time only
npm run dev
```

Then open:

### → **http://localhost:5173/__hub/**

The `/__hub/` path matters — it's the SPA base path, chosen so the same bundle can be hosted
by the Wails3 native app later (which claims `/wails/`). A bare `/` on the dev server will
not find the app.

### Single-process alternative

Build the frontend once and let `cairnd` serve it — no Node needed at runtime:

```sh
cd webapp && npm run build && cd ..
go run ./cmd/cairnd
```

Then open **http://localhost:8099/__hub/** (`/` redirects there).

---

## Things to try

- **Open two browser tabs.** Each tab gets its own session key (`sessionStorage`), so they act
  as two distinct participants, while sharing the room key (`localStorage`). Send a message in
  one and watch it converge in the other over SSE.
- **`/inlay greenhouse`** in the composer — posts a *declared inlay* rendered entirely from
  primitives by the generic role renderer. Also `poll`, `tasks`, `agent`, `widget`.
  `greenhouse` is deliberately **not** standard-library, so it demonstrates the per-room
  default-deny allowlist and the mandatory text fallback.
- **Paperclip icon** — encrypts the file locally, uploads only ciphertext, and posts a tiny
  `file_ref` envelope. The card shows honest retrieval state
  (`available` / `pending — no fat link` / `downloading` / `broken`).
- **Members icon** (room header) — shows your member key, adds a member by pasted key
  (mints a new room-key epoch, HPKE-wrapped to everyone), rotates the key, or copies a
  room-key link for a second browser.
- **Restart `cairnd`** — history survives; it's in SQLite.

---

## Configuration

`cairnd` runs with sensible defaults and no config file. To override, create `config.yaml`
(or copy [`config.example.yaml`](./config.example.yaml)) and pass it:

```sh
go run ./cmd/cairnd -configFile config.yaml
```

| Key | Default | Meaning |
|---|---|---|
| `address` | `:8099` | HTTP listen address |
| `store` | `sqlite` | storage backend |
| `sqlitePath` | `cairn.db` | SQLite file |
| `webappDir` | `webapp/dist` | built SPA to serve (skipped if absent) |
| `blobDir` | `cairn-blobs` | local blob store directory |
| `trustedRoots` | *(empty)* | hex household root pubkeys. **Empty = accept any well-formed signed event** (dev). Once set, senders must chain to one of these roots. |

**Dev-phase policy:** there are no migrations. To reset, stop the server and delete
`cairn.db*` and `cairn-blobs/`.

---

## Tests and checks

```sh
go test ./...                  # crypto, DAG convergence, room keys, HPKE, blobs
go vet ./...

cd webapp
npm run check                  # svelte-check + tsc
npm run conformance            # browser event_ids must match Go byte-for-byte
npm run inlay-check            # every declaration's binds resolve against its bindings
npm run build
```

`npm run conformance` is the important one: it asserts golden `event_id` vectors against the
same values a Go test asserts, so any drift in the canonical CBOR / BLAKE3 encoding fails a
test instead of silently breaking Go↔browser interop.

---

## Regenerating the wire schema

Only needed if you edit `proto/cairn.proto`.

```sh
go install github.com/bufbuild/buf/cmd/buf@latest
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install connectrpc.com/connect/cmd/protoc-gen-connect-go@latest
# ensure $(go env GOPATH)/bin is on PATH

buf generate                   # Go   → proto/cairnv1/
cd webapp && npm run gen       # TS   → webapp/src/gen/
```

Never hand-edit generated code.

---

## Repo layout

```
proto/          wire schema + generated Go — THE contract
identity/       Ed25519 delegation chain: sign + chain-walk verify
event/          canonical CBOR, BLAKE3 event_id, sign/verify, DAG heads
room/           per-room E2EE (AES-256-GCM) + HPKE room-key handoff
approval/       portable signed capability artifacts (the human's signature)
blobs/          data plane: file_ref envelope + Backend (local impl)
store/          store.Store interface; store/sqlite implementation
config/ core/ controllers/ router/     wiring, Connect handlers, SSE, blob gateway
cmd/cairnd/     the server binary
webapp/         Svelte + Vite PWA (the UI)
claude-design/  React mockup — visual reference, not shipped
```

---

## Known caveats

- **⚠️ `blobs` is not iroh-store.** `plan.md` specifies an iroh-store gRPC client; the shipped
  backend is a local filesystem store behind a `Backend` interface. Content addressing,
  encryption, range reads, and retrieval states are all real; peer-to-peer fetch and real
  pinning are not. Full rationale in [`decisions.md`](./decisions.md) §Deviations.
- **The capability broker is external** and not built here. Cairn delivers a capability
  request, lets you sign a grant **in the UI** with your key, and produces a portable artifact
  the agent carries to the broker. Cairn never mints credentials or evaluates policy.
- **The UI has not been visually verified in a real browser.** It typechecks, builds, serves,
  and its protocol/crypto paths are proven by cross-language harnesses — but the development
  environment could not run a browser, so expect visual papercuts.

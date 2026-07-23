# Cairn

A local-first, end-to-end-encrypted comms client for **humans *and* agents**, built on a
custom Go protocol: a per-room signed event DAG over Ed25519 identities, with pluggable
transports (LAN/HTTP today; Meshtastic, BLE, and iroh planned).

Every message is a signed event in an append-only, per-room DAG. Rooms are E2EE. Identities
are Ed25519 delegation chains, not accounts on a server. The server is **convenience, not
authority** — it adds history continuity and a blob gateway, but events are verifiable on
their own and the DAG converges without it. A "node" is any keyholder that folds that DAG;
the home server is just a node that happens to be always on.

---

## Documentation

Everything lives in [`docs/`](./docs) — start at the [documentation index](./docs/README.md).

- [**Architecture**](./docs/architecture.md) — nodes, transports, sync, and how one `core`
  runs on a server, a phone (Wails3), and in a browser. The mobile / BLE / Meshtastic story.
- [**Events & E2EE**](./docs/events-and-e2ee.md) — the crypto in depth: the household &
  member roots, the delegation chain, adding users and devices, revocation, rooms, and how
  room keys rotate. Illustrated with diagrams.
- [**Protocol**](./docs/protocol.md) — the terse wire contract (envelope, payloads, DAG, sync,
  SQLite schema).
- [**Approvals & inlays**](./docs/approvals-and-inlays.md) — portable signed capability grants
  and the agent-definable inlay UI.
- [**Plan**](./docs/plan.md) · [**Milestones**](./docs/milestones.md) ·
  [**Decisions**](./docs/decisions.md) — the phased build plan, exit criteria, and the settled
  decisions + ⚠️ known deviations.
- [`PROJECT.md`](./PROJECT.md) — a one-page orientation for contributors.

### Architecture in one picture

One `core` (Go) is the node. The server, a phone, and a browser differ only in which
transports they can reach and whether they're always on — not in authority, because there
isn't any. Full detail in [`docs/architecture.md`](./docs/architecture.md).

![Node & transport topology](./docs/diagrams/node-topology.svg)

---

## Prerequisites

| | Version | Notes |
|---|---|---|
| **Go** | **1.25+** | `go.mod` targets 1.25.10 |
| **Node** | **20.19+** or **22.12+** | required by Vite 8 |

**With [mise](https://mise.jdx.dev) both are pinned for you** — `mise.toml` is in the repo:

```sh
mise trust && mise install     # once
```

After that the right Go and Node are on PATH inside this directory. Worth doing: a
machine default of Node 18 fails in ways that don't point at the Node version —
`npm run dev` dies on a missing `styleText` export, and `npm run build` and the
conformance scripts fail separately.

Handy tasks: `mise run dev` (cairnd), `mise run web` (Vite), `mise run check`
(everything CI would run), `mise run reset` (wipe server state).

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

# Found the household. ONCE, on the machine that runs Cairn. It shows a 24-word
# phrase, asks for three words back, and records the household root in
# trusted-roots.txt so the server is strict from the first event.
go run ./cmd/cairnctl init -name "Our household"

go run ./cmd/cairnd
```

The household's words are never typed into the browser — they can vouch for anyone as anyone,
so they stay on the server (see [`docs/decisions.md`](./docs/decisions.md) §Founding and
attestation move to the CLI). An un-founded node refuses every event: an empty trust list is
default-deny, not open.

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

- **Set up an identity.** Everyone **joins**, including whoever founded the household — there
  is no separate founder path in the app. Take *Join a household*, write down **your own**
  24-word phrase (yours, not the household's), confirm three words back, and copy the join code.
  Then on the server:

  ```sh
  go run ./cmd/cairnctl attest <their join code>
  ```

  It prints an invite to paste back, and the household fingerprint they should see. Compare it
  out loud — that comparison is load-bearing, because an invite's household is self-declared and
  a stranger's household verifies its own signature perfectly.
- **Add a second person.** Same thing: they join in a fresh browser, you run `cairnctl attest`
  with their code. `go run ./cmd/cairnctl roots` shows what this node trusts.
- **Open two browser windows.** The member + device keys persist in `localStorage`, so two
  *tabs* are one member. For two distinct participants use a normal and a private window (or two
  browser profiles), each with its own household. Send a message in one and watch it converge in
  the other over SSE.
- **Create a room.** A new household has **no rooms** — the sidebar is empty by design.
  Hit **+** to create one; you become its first member and it mints the room key. Add someone
  with **Members & keys** → paste their member key (from their **Identity & devices → You**).
  Joining a household does *not* grant room access: those are separate acts.
- **Reset this device** — **Identity & devices → You → Reset this device**. Erases keys, room
  keys and the cached DAG. Not a "log out": there is no server session, the keys *are* the
  account, and without your 24 words the household is gone from this device.
- **Add another device.** On the new device choose *Add this device to my account* — it shows a
  QR code and waits. On a device you already use: **Identity & devices → Pair → Scan QR code**,
  compare the fingerprint on both screens, approve. The new device is delegated by the one that
  scanned it, and every room key you hold is re-wrapped to it (going forward, not history).
  Revoking is permanent, and **cascades**: revoking a device also cuts off everything paired
  from it, which the confirm dialog names before you agree.
- **`/inlay greenhouse`** in the composer — posts a *declared inlay* rendered entirely from
  primitives by the generic role renderer. Also `poll`, `tasks`, `agent`, `widget`.
  `greenhouse` is deliberately **not** standard-library, so it demonstrates the per-room
  default-deny allowlist and the mandatory text fallback.
- **Paperclip icon** — encrypts the file locally, uploads only ciphertext, and posts a tiny
  `file_ref` envelope. The card shows honest retrieval state
  (`available` / `pending — no fat link` / `downloading` / `broken`).
- **Members icon** (room header) — adds a member by their **full member key** (they copy it
  from the rail avatar → **You**), rotates the key, or copies a room-key link. Adding mints a
  new epoch HPKE-wrapped to every member. **"Let them read past messages"** also wraps the
  older epochs to them — off by default, irreversible once granted, and visible to the room.
- **Restart `cairnd`** — history survives; it's in SQLite.

---

## A headless client (`cmd/agent`)

Proof that the protocol is client-agnostic: a plain Go program with an Ed25519 keypair,
speaking the same signed events as the browser. It is a **full node** — the same thing an
embedded on-device `core` will be.

```sh
# create a room, admit a human by their MEMBER key, post inlays + a capability request
go run ./cmd/agent -member <64-hex member key> -room demo

# verify the human's decision — standalone: signature, expiry, and binding to the
# exact capability and agent. Works for both approval_grant and approval_deny.
go run ./cmd/agent -watch <room-id>
```

Copy the member key from the rail avatar → **You** → *Copy member key*.

> Keys go to `$TMPDIR/cairn-agent` by default (never `$HOME`) — this is a test client and it
> stores a private key plus **plaintext room keys**. Use `-keys` to choose deliberately.
>
> Not idempotent: re-running for an existing room mints a fresh key at the same epoch and
> collides with the key members already hold. Use a new `-room` name each time.

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
| `trustedRoots` | *(empty)* | hex household root pubkeys. **Empty = awaiting founding**: the node refuses every event until the first attestation adopts a household root, then enforces against it (persisted across restarts). Set it to pin exactly the roots you trust and be strict from t=0. Never an "accept anything" mode. |

**Dev-phase policy:** there are no migrations. Resetting takes **both sides**, in this order:

1. **Close every Cairn tab**, and clear the browser's site data for the origin
   (DevTools → Application → Storage → *Clear site data*). This drops the IndexedDB DAG cache
   (`cairn`), the identity vault and room keys (`localStorage`), and the session key
   (`sessionStorage`).
2. **Then** stop the server and delete `cairn.db*` and `cairn-blobs/`, and — if you want a new
   household — `trusted-roots.txt`.

> ⚠️ **Order matters.** Cairn is local-first: a client holds the full DAG and pushes anything
> the server lacks on reconnect (frontier sync). Wipe the server with a tab still open and that
> client immediately re-uploads its history — the database refills itself and it looks like the
> wipe silently failed. It didn't; the client won.

---

## Tests and checks

```sh
go test ./...                  # crypto, DAG convergence, room keys, HPKE, blobs
go vet ./...

cd webapp
npm run check                  # svelte-check + tsc
npm run conformance            # browser event_ids must match Go byte-for-byte
npm run identity-conformance   # browser household derivation + attestation sigs match Go
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
cmd/cairnd/     the server binary   ·   cmd/cairnctl/  founding + attestation CLI
cmd/agent/      a headless Go node (demo)   ·   cmd/smoke/  end-to-end check
webapp/         Svelte + Vite PWA (the UI)
docs/           architecture, protocol, crypto, plan, decisions, diagrams
claude-design/  React mockup — visual reference, not shipped
```

---

## Documentation authoring

Diagrams under [`docs/diagrams/`](./docs/diagrams) are [D2](https://d2lang.com) sources
(`*.d2`) rendered to committed SVGs. To regenerate after editing a `.d2`:

```sh
d2 --theme 0 --pad 24 docs/diagrams/<name>.d2 docs/diagrams/<name>.svg
```

---

## Known caveats

- **⚠️ `blobs` is not iroh-store.** [`docs/plan.md`](./docs/plan.md) specifies an iroh-store
  gRPC client; the shipped backend is a local filesystem store behind a `Backend` interface.
  Content addressing, encryption, range reads, and retrieval states are all real; peer-to-peer
  fetch and real pinning are not. Full rationale in [`docs/decisions.md`](./docs/decisions.md)
  §Deviations.
- **The capability broker is external** and not built here. Cairn delivers a capability
  request, lets you sign a grant **in the UI** with your key, and produces a portable artifact
  the agent carries to the broker. Cairn never mints credentials or evaluates policy.
- **Device pairing is paste-a-code, not scan-a-code.** The QR is rendered and the payload is
  final, but there is no camera capture yet — you copy the `cairn:pair:1:…` string between
  devices. Camera scanning needs `getUserMedia` and a secure context.
- **Alternate transports are not built yet.** Everything moves over HTTP (Connect + SSE) today.
  The `transport/` interface, the pubkey-addressed router, LAN/BLE/Meshtastic, and the Wails3
  on-device node are planned, not present — see [`docs/architecture.md`](./docs/architecture.md)
  §Current state vs. target and the phases in [`docs/plan.md`](./docs/plan.md).
- **Spaces admit-policy, peer-household join, and notification settings are not built.** They
  are the deferred half of Phase 4 (see [`docs/plan.md`](./docs/plan.md)).

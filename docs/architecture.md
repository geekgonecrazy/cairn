# Architecture: nodes, transports, and topology

How Cairn is put together at the system level — what a *node* is, how nodes find
and sync with each other, and how the same code runs on a home server, a phone,
and in a browser tab. This is the companion to [`events-and-e2ee.md`](events-and-e2ee.md)
(the crypto and event model) and [`protocol.md`](protocol.md) (the wire spec).

> **Status legend.** Sections marked **[built]** describe code that exists today;
> **[target]** describes the intended shape that parts of the codebase are being
> moved toward. The distinction is called out explicitly rather than blurred —
> see [Current state vs. target](#current-state-vs-target) for the honest summary.

---

## 1. The core idea: everything is a node

A **node** is not "a server". A node is a keyholder that folds the converging
event DAG. Concretely:

```
Node = core (store + chain gate + fold)
     + identity/keys (a device key; maybe a session key)
     + a set of Transports it can reach peers over
     + a sync driver (run frontier sync with each peer when a route is up)
```

The home server, a phone, and a browser tab are all nodes. They differ only in
which **transports** they can reach and whether they are **always on** — not in
their authority, because there is no authority. Every node runs the same trust
decision (a chain walk to a household root it recognizes, see
[`events-and-e2ee.md` §4](events-and-e2ee.md#4-identity-the-key-hierarchy)) and
the same fold (materializing rooms, spaces, and membership from signed events).

This is why the design's central claim holds: **the server is convenience, not
authority** ([`protocol.md` §8](protocol.md#8-api-surface)). Events are
self-authenticating and content-addressed, and the DAG converges by hash-set
union without anyone coordinating it. A node that never talks to the server can
still hold a complete, verified history.

![Node & transport topology — the home server is just a node that happens to be permanent](diagrams/node-topology.svg)

### "The server just happens to be a permanent node"

The thing that usually makes a server special is that it accumulates state the
clients trust. That has not happened here, and the code shows it: the `core`
package imports no `net/http` and knows nothing about serving. It is
`store` + the chain gate (`core.SubmitEvent`) + the fold (`core.applyRoomState`)
+ trusted roots. What we call "the server" (`cairnd`) is `core` plus a few
**services it exposes** — a ConnectRPC unary API, an SSE stream, and a blob
gateway (`router/`, `controllers/`).

Strip those services away and you have a node. Add them to a phone and the phone
is a server. The home server's *only* distinguished property is that it is
**always on**, which earns it exactly one role the others can't fill:
**store-and-forward rendezvous.** Two phones that are never online at the same
time still converge, because the permanent node held the events in between. That
is availability, not authority.

---

## 2. Transports

Recipients are **pubkeys, not addresses** ([`protocol.md` §9](protocol.md#9-transport-routing-summary-full-table-in-the-vision)).
A transport's only job is to move an opaque, signed event frame from one node to
a peer identified by its key. Because the event is self-authenticating and the
DAG dedups by `event_id`, a transport never has to renegotiate trust or ordering
— it just moves bytes, and sync sorts out the rest.

| Transport | Reaches | Carries | Status |
|-----------|---------|---------|--------|
| **HTTP** (ConnectRPC + SSE) | any node with an address | events + blobs | **[built]** — the one path today |
| **LAN** (mDNS + direct) | same-network nodes | events + blobs | **[target]** — Phase 1/3 |
| **BLE GATT** | nearby nodes | events (framed to the MTU) | **[target]** — Phase 5 |
| **Meshtastic (LoRa)** | long-range, no infra | events framed to ~200 B; **never file bytes** | **[target]** — Phase 3 |
| **iroh** | WAN peer-to-peer | blob data plane | **[target]** — later |

The wire already reserves the future: `Event.arrived_via` (receiver-populated,
never signed) and a `TransportHint` enum (`LAN`/`MESH`/`BLE`/`ALL`) exist in the
proto so that adding transports does not break the format. `models.Room` carries
a `transport_pref` string for the same reason.

### Routing **[target]**

Per-recipient priority over the transports that can currently reach that pubkey:
LAN → BLE → Meshtastic → iroh-WAN. Try-and-fall-through with a small time budget;
queue locally with a TTL if nothing reaches the key; dedup by `event_id`, so
multi-path delivery is harmless. Per-type defaults keep chatty events off
expensive links (`chat` takes the cheapest route; `approval_request`,
`call_ring`, and capability-bound `interaction` broadcast over everything and
cannot be downgraded). Preference resolves most-specific-first: per-message hint
→ per-room preference → user mode (`auto`/`field`/`home`/`mesh-only`/`lan-only`).
`arrived_via` on inbound events feeds reachability back into the router.

File bytes **never** ride the mesh — only the `file_ref` envelope does. Bytes
travel the data plane (`blobs/`, today a local filesystem backend standing in for
iroh; see [`decisions.md`](decisions.md)). That rule is independent of transport.

---

## 3. Sync

The unit of delivery is the **frontier exchange** ([`protocol.md` §6](protocol.md#6-sync-the-frontier--outbox)),
which is a diff over the DAG, not a queue:

1. A node sends the heads it holds: `SyncRequest{ have_heads }`.
2. The peer returns everything reachable from *its* heads but not from
   `have_heads`, plus its own heads.
3. The node applies the missing events (dedup by `event_id`), recomputes heads,
   and pushes back whatever the peer lacks.
4. A missing parent is fetched by hash and walked back; out-of-order is normal.
5. Per-peer heads persist in `peer_frontier` — "undelivered to peer X" is just
   the local events not behind X's frontier. Retried when a route returns.

**[built]** Today this runs as a client→server pull (`CairnService.Sync`), with
SSE as a one-way server→client push notification. A dropped SSE frame is never a
lost message: the client re-syncs on reconnect.

**[target]** The same exchange becomes symmetric and node-to-node: any node runs
it against any peer over any transport, and the server *initiates* too, because it
is a peer. SSE demotes to one transport's "nudge"; the actual reconciliation is
always the frontier sync. The one genuinely queue-shaped piece — the "push now,
retry when a route returns" driver over `peer_frontier` — is the sync driver
named in [§1](#1-the-core-idea-everything-is-a-node).

---

## 4. Where the same node runs

### Home server **[built]**

`cairnd` — `core` plus the HTTP/SSE/blob services. Always on. Durable SQLite
(`store/sqlite`, `modernc.org/sqlite`, pure-Go, no cgo). Its role is
store-and-forward rendezvous and the blob gateway. It holds no key material for
any member and cannot read a room.

### Mobile (Wails3) **[target — Phase 5]**

The native app **embeds `core`** as a full on-device node: durable SQLite, the
chain gate, the fold, and — uniquely — the transports a browser can never have
(LAN, BLE, Meshtastic). Because `core` imports nothing server-shaped, embedding
it is a build target, not a rewrite. On mobile the Svelte UI talks to the
embedded `core` directly (Wails bindings or loopback) rather than to a remote
`cairnd`. The pure-Go SQLite driver is what makes this cross-compile cleanly to
iOS and Android.

Platform landmines are known and tracked in [`plan.md` §6](plan.md): iOS mDNS
needs the (unapproved) multicast entitlement, so LAN on iOS needs a fallback;
passkey RP-ID needs a real registrable domain.

### Browser (PWA) **[built as a TS port; target is WASM]**

A browser cannot run native Go, so today the browser is a **hand-maintained
TypeScript reimplementation** of the node's crypto and fold
(`webapp/src/lib/`), kept byte-identical to Go by conformance vectors
([`events-and-e2ee.md` §15](events-and-e2ee.md#15-cross-language-consistency)).
It signs with a per-tab session key, folds rooms/spaces itself, and reaches the
world over HTTP+SSE only.

The **target** is to compile `core`+`event`+`room`+`identity` to **WASM** so the
browser runs the *same Go node*, with HTTP as its only transport — retiring the
TS port and the conformance-vector tax entirely. What necessarily stays in
JavaScript is small and non-cryptographic-in-logic: the **WebAuthn/passkey
ceremony** (a browser-only API that authorizes the session key), the `fetch`/SSE
glue, an IndexedDB bridge, and the DOM. This is the one load-bearing open
decision — see [`plan.md` §5](plan.md) and [`decisions.md`](decisions.md).

A browser's transport set is **permanently HTTP-only** — no browser does BLE or
LoRa. Browser nodes therefore reach the mesh *through* a permanent or mobile
node. Full peer-to-peer sync happens among the Go-native nodes; browser-to-browser
direct sync would need a WebRTC/WebTransport transport, which is later work.

---

## 5. Discovery and first contact **[target]**

### BLE: broadcast a key, accept if known

Discovery over BLE is promiscuous at the radio and gated by the trust model you
already have:

1. **Advertise.** A node's BLE GAP advertisement carries its device **pubkey**
   (plus reachability). Every nearby node hears every advertiser.
2. **Exchange identity objects on first contact.** A node may not yet hold a new
   peer's delegation chain and attestation. Those are content-addressed and
   fetched by hash — over BLE, the two nodes exchange them on the GATT link
   (the peer-to-peer form of `GetIdentityObject`/`PutIdentityObject`).
3. **Accept iff the chain terminates at a known root.** This is exactly
   `identity.VerifySender` — walk device → … → member root → household root, and
   accept only if that root is one this node trusts. The same decision the
   carrier makes today ([`events-and-e2ee.md` §8](events-and-e2ee.md#8-the-chain-gate)),
   moved onto the device. A federated peer household you have pinned is accepted
   the same way.

So the intuition "broadcast, hear it, accept if it's known to me" is right, and
it needs no new trust primitive. Two open design points: advertising a static
pubkey is a **trackable beacon** (a bitchat-class design would rotate ephemeral
advertised IDs — undecided), and BLE is proximity-only (multi-hop BLE relay is a
separate question from 1:1 GATT).

### Meshtastic: two topologies, one code path

A "node" is a keyholder that folds the DAG, so a Meshtastic radio can hang off
either kind of node:

- **Home server bridges the mesh.** `cairnd` on the hub owns a LoRa radio
  (serial or MQTT bridge) and relays events between mesh and LAN/WAN. Field
  devices reach home over LoRa; home fans out to everyone else. This is the
  always-on rendezvous node with a radio attached.
- **Mobile drives its own radio.** The Wails3 app embeds `core` *and* an attached
  Meshtastic radio, so two phones converge a room in the field with **no
  infrastructure at all** — each is a full peer that signs, folds, and syncs over
  LoRa.

Same `core` + a `transport/mesh` implementation; the only difference is which box
the radio is plugged into. The work is the mesh transport itself: framing to the
~200 B LoRa MTU, a gap-tolerant queue with `event_id` dedup, and per-type routing
so chatty events never burn airtime.

---

## 6. Current state vs. target

**What is real today.** The parts that are hard to retrofit are done: a
self-authenticating, converging event DAG; pubkey-addressed identity and E2EE;
reserved wire fields for transports; a complete Go client stack (`cmd/agent`,
`cmd/smoke` are full nodes) plus a byte-parity browser port. `core` is already
node-logic, not server-logic. Spaces, membership, and their authority fold
identically on every node with no server privilege.

**What is not built.** There is no `transport/` interface package and no
`native/` on-device node. Everything moves over one transport (HTTP) reached one
way (`cairnd`'s services), and fan-out is connection-bound (the SSE `Hub`), not
pubkey-addressed. The routing table, the symmetric sync driver, and the outbox
retry loop are described here and in `plan.md` but not yet implemented.

**The seam to cut first.** Introduce a `Transport` interface (`Send(pubkey,
frame)`, `Available()`, an inbound channel) with the existing HTTP/SSE path
refactored to be its first implementation, and a `Node` abstraction so `core`
stops assuming "one server reached over HTTP". None of this touches the protocol
or the crypto — it is additive plumbing. Everything else (symmetric sync, the
Wails3 embed, the browser-WASM decision, then BLE and Meshtastic) slots in behind
that seam. The phased breakdown lives in [`plan.md`](plan.md); the exit criteria
in [`milestones.md`](milestones.md).

# Cairn documentation

Start here. Cairn is a local-first, end-to-end-encrypted comms protocol for humans and agents
— a per-room signed event DAG over Ed25519 delegation chains, with the server as just a
convenient always-on node. For running it, see the [top-level README](../README.md).

## The documents

| Doc | What's in it |
|-----|--------------|
| [**architecture.md**](architecture.md) | Nodes, transports, and topology. How one `core` runs on a server, a phone (Wails3), and in a browser; sync between nodes; the mobile / BLE / Meshtastic story; the **v2 trust/relay direction** (pubkey identity, relays as bridges, invites, interest-based routing); current state vs. target. |
| [**events-and-e2ee.md**](events-and-e2ee.md) | The crypto and event model in depth, with diagrams: the household & member roots, the delegation chain, adding users and devices, revocation, rooms & membership, and how room keys rotate. |
| [**protocol.md**](protocol.md) | The terse wire contract: identity objects, the event envelope, payload schemas, the DAG, sync, room keys, the API, and the SQLite schema. |
| [**approvals-and-inlays.md**](approvals-and-inlays.md) | Portable signed capability grants (the human's signature, verifiable outside Cairn) and the agent-definable inlay UI. |
| [**plan.md**](plan.md) | The phased build plan (Phases 0–6). |
| [**milestones.md**](milestones.md) | Per-phase "done" definitions and exit criteria. |
| [**adrs/**](adrs/README.md) | Architecture Decision Records — the settled decisions and ⚠️ known deviations, one decision per file, in chronological order, covering only what's currently built. |

## Understand a specific flow

Jump straight to the answer:

- **How the trust chain is built** — household root, member root, device tree, session key →
  [Identity: the key hierarchy](events-and-e2ee.md#4-identity-the-key-hierarchy)
- **How a sender is verified** →
  [Verifying a sender (the chain walk)](events-and-e2ee.md#verifying-a-sender-the-chain-walk)
- **Adding a user** to the household →
  [Onboarding a human](events-and-e2ee.md#5-onboarding-a-human)
- **Adding a new device** for a user →
  [Adding a device (pairing)](events-and-e2ee.md#6-adding-a-device-pairing)
- **Removing a device** (and the cascade) →
  [Removing a device (revoke)](events-and-e2ee.md#7-removing-a-device-revoke)
- **Rooms & room membership** →
  [Rooms and spaces](events-and-e2ee.md#9-rooms-and-spaces)
- **What happens when a room is created / someone is added / removed / keys rotate** →
  [Room encryption](events-and-e2ee.md#10-room-encryption),
  [Adding someone to a room](events-and-e2ee.md#11-adding-someone-to-a-room),
  [Removing someone from a room](events-and-e2ee.md#12-removing-someone-from-a-room)
- **What happens when a new device gets a user's room keys** →
  [What happens when a new device is added](events-and-e2ee.md#13-what-happens-when-a-new-device-is-added)
- **How mobile, BLE, and Meshtastic fit** →
  [architecture.md](architecture.md)
- **The trust/relay direction** — pubkey identity, relays as bridges, invites, interest-based
  routing (the decided v2 model, not yet built) →
  [adrs/0013–0016](adrs/README.md) + [architecture.md §2/§6](architecture.md)

## Diagrams

Sources and rendered SVGs live in [`diagrams/`](diagrams). They are authored in
[D2](https://d2lang.com) (`*.d2`) and rendered to committed SVGs:

```sh
d2 --theme 0 --pad 24 docs/diagrams/<name>.d2 docs/diagrams/<name>.svg
```

| Diagram | Shows |
|---------|-------|
| `trust-hierarchy` | A self-sovereign member root and its device tree (member → device tree → session). |
| `chain-verify` | The `VerifySender` walk down to a member root — and why resolving ≠ admitting ≠ trusting. |
| `relay-and-trust` | Relays: admission (allow-list, invites, directory) vs. identity vs. edge trust. |
| `add-member` | A member joins a relay: self-attest, pin the relay, redeem an invite (or TOFU). |
| `device-pairing` | QR pairing: public key out, signed delegation back. |
| `device-revoke` | Revocation and its two-part (auth + key) cascade. |
| `rooms-spaces` | Rooms, spaces, and the two membership tiers. |
| `room-keys` | Room-key epochs and rotation on join/leave. |
| `event-and-sync` | The event envelope and frontier sync between two nodes. |
| `node-topology` | Node & transport topology — relay, mobile, browser. |

## A note on sources of truth

Where a doc and the code disagree, **the code wins** — file references are given throughout so
you can check. The `events-and-e2ee.md` and `architecture.md` writeups are grounded in the Go
source (`identity/`, `event/`, `room/`, `core/`) and its byte-parity browser port
(`webapp/src/lib/`), kept honest by conformance vectors.

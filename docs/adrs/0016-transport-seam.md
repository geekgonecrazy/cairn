# 16. Transports plug into one interface; the node treats them uniformly

- Status: Accepted
- Date: 2026-07-24

## Context

Cairn must eventually move signed events over many transports — LAN, BLE, Meshtastic,
relay-to-relay bridges — not just HTTP/SSE. That should not mean bolting each one onto the
write path ad hoc, and it must not require touching the protocol or the crypto.

## Decision

A single `transport.Transport` interface (`Name` / `Available` / `Broadcast` / `Inbound`)
is the seam every transport plugs into. The node **registers** its transports and treats
them **uniformly**: an event arriving from *any* transport's `Inbound` goes through the
same `verify → store → fold → fan-out` path, and outbound fan-out goes to *every*
transport. HTTP/SSE is the first implementation.

## Consequences

- Because events are self-authenticating ([ADR-0003](0003-signed-event-dag.md)), a
  transport only has to move bytes; verification, ordering, and dedup stay the node's job,
  and per-transport framing (e.g. mesh MTU chunking) is the implementation's concern.
- New transports — LAN, BLE, Meshtastic, relay-to-relay — plug in behind the interface
  without touching the protocol or crypto.
- Today only the SSE transport is registered; **pubkey-addressed routing**, the **symmetric
  sync driver**, and the actual alternate transports are still ahead.
- Local client submissions still arrive synchronously via the `SendEvent` RPC (so they can
  return a verify error to the caller); a transport's `Inbound` is for events from *peers*.

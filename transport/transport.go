// Package transport is the seam every way of moving signed events between nodes
// plugs into: HTTP/SSE today, and LAN, BLE, Meshtastic, and relay-to-relay
// bridging behind the same interface later (docs/architecture.md §3, §6). A node
// (package core) registers its transports and treats them uniformly — inbound
// events from any transport are verified, stored, folded, and re-broadcast the
// same way, and outbound fan-out goes to all of them.
package transport

import cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"

// Transport moves signed events between this node and its peers. Events are
// self-authenticating and content-addressed, so a transport only has to move
// them — verification, ordering, and dedup are the node's job, and per-transport
// framing/serialization (e.g. mesh MTU chunking) is the implementation's concern.
//
// Pubkey-addressed routing (Send to a specific member over the best reachable
// transport) is a later slice; today the interface is fan-out + inbound, which
// matches the one HTTP/SSE transport.
type Transport interface {
	// Name identifies the transport; it populates Event.arrived_via on inbound.
	Name() string
	// Available reports whether the transport can currently move events.
	Available() bool
	// Broadcast fans an event out to every peer/subscriber this transport can
	// currently reach.
	Broadcast(ev *cairnv1.Event)
	// Inbound is the stream of events arriving from peers over this transport; the
	// node pumps it into its write path. A transport with no peer-inbound — e.g.
	// the server's SSE stream, whose inbound is the synchronous SendEvent RPC —
	// returns a channel that never yields.
	Inbound() <-chan *cairnv1.Event
}

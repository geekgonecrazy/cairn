package core

// The transport seam. A node registers its transports (HTTP/SSE today; LAN, BLE,
// Meshtastic, relay-to-relay later) and treats them uniformly: inbound events
// from any transport go through the same verify→store→fold→fan-out path, and
// outbound fan-out goes to every transport. See package transport and
// docs/architecture.md §3.

import (
	"log"

	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
	"github.com/geekgonecrazy/cairn/transport"
)

// transports are registered at startup (before serving), so this is read without
// locking on the hot path.
var transports []transport.Transport

// RegisterTransport adds a transport and starts pumping its inbound events into
// the write path. The HTTP/SSE transport is registered at Setup; future
// transports register the same way and get the same treatment for free.
func RegisterTransport(t transport.Transport) {
	transports = append(transports, t)
	go consume(t)
}

// consume feeds events arriving from a transport's peers into SubmitEvent, so an
// event from ANY transport is treated exactly like a local submission. Local
// client submissions instead arrive synchronously via the SendEvent RPC, so they
// can return a verify error to the caller.
func consume(t transport.Transport) {
	for ev := range t.Inbound() {
		ev.ArrivedVia = t.Name()
		if err := SubmitEvent(ev); err != nil {
			log.Printf("transport %s: inbound event refused: %v", t.Name(), err)
		}
	}
}

// broadcast fans an event out over every available transport — the SSE hub is now
// just one transport behind this seam.
//
// NOTE: a received event is currently re-broadcast to every transport, including
// the one it arrived on. Dedup by event_id makes that harmless (a peer already
// holds it), and for SSE it is exactly right (fan out to the other subscribers).
// Not echoing back to the source transport is a routing refinement for a later
// slice.
func broadcast(ev *cairnv1.Event) {
	for _, t := range transports {
		if t.Available() {
			t.Broadcast(ev)
		}
	}
}

// resetTransports is a test helper (transports is startup-only in production).
func resetTransports() { transports = nil }

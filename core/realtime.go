package core

import (
	"sync"

	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// Hub is the realtime fan-out behind the SSE stream. It is deliberately lossy:
// a slow subscriber's buffer is allowed to drop frames, because the client
// re-syncs via Sync on (re)connect — a missed SSE frame is never a lost message
// (PROTOCOL.md §8). This keeps one stalled browser from backing up the server.
type Hub struct {
	mu   sync.RWMutex
	subs map[*Subscriber]struct{}
}

// Subscriber is one live SSE connection's inbound event channel.
type Subscriber struct {
	C chan *cairnv1.Event
}

func newHub() *Hub { return &Hub{subs: map[*Subscriber]struct{}{}} }

// Subscribe registers a new realtime subscriber and returns it with a cancel
// func the caller must defer to unregister and close the channel.
func Subscribe() (*Subscriber, func()) {
	s := &Subscriber{C: make(chan *cairnv1.Event, 64)}
	hub.mu.Lock()
	hub.subs[s] = struct{}{}
	hub.mu.Unlock()
	return s, func() {
		hub.mu.Lock()
		if _, ok := hub.subs[s]; ok {
			delete(hub.subs, s)
			close(s.C)
		}
		hub.mu.Unlock()
	}
}

// broadcast delivers ev to every subscriber, dropping it for any whose buffer
// is full (they will catch up on their next Sync).
func (h *Hub) broadcast(ev *cairnv1.Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs {
		select {
		case s.C <- ev:
		default:
		}
	}
}

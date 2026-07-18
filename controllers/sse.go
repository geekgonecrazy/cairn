package controllers

import (
	"encoding/base64"
	"fmt"
	"net/http"

	"github.com/geekgonecrazy/cairn/core"
	"github.com/geekgonecrazy/cairn/event"
)

// SubscribeSSE is the realtime endpoint (GET /v1/subscribe). It is a plain HTTP
// text/event-stream — the decided realtime transport (decisions.md), matching
// flockledger's SSE precedent, NOT a Connect server-stream. Each new Event is
// pushed as its protobuf bytes, base64 in the SSE data field (PROTOCOL.md §8).
// The client re-syncs via Sync on connect, so a dropped frame is never a lost
// message.
func SubscribeSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable proxy buffering

	sub, cancel := core.Subscribe()
	defer cancel()

	// Open the stream so the client's EventSource fires `onopen`.
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-sub.C:
			if !ok {
				return
			}
			wire, err := event.Encode(ev)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: cairn\ndata: %s\n\n", base64.StdEncoding.EncodeToString(wire))
			flusher.Flush()
		}
	}
}

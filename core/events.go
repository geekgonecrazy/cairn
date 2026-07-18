package core

import (
	"fmt"
	"log"
	"time"

	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// SubmitEvent is the write path: verify, persist, fan out. The server is
// convenience, not authority — it accepts an event only if it is internally
// valid (event.Verify) and, when trusted roots are configured, chains to one of
// them (identity.VerifySender). On a genuinely new insert it broadcasts to
// realtime subscribers.
func SubmitEvent(ev *cairnv1.Event) error {
	if ev == nil {
		return fmt.Errorf("core: nil event")
	}
	if err := event.Verify(ev); err != nil {
		return err // ErrIDMismatch / ErrBadSig
	}

	// Chain gate is opt-in during early dev: with no trusted roots configured we
	// accept any well-formed signed event. Once roots are set, the sender must
	// verify back to one (ErrUnknownObject ⇒ client should push identity objects
	// via the identity log first, then retry).
	if len(trustedRoots) > 0 {
		if _, err := identity.VerifySender(ev.SenderPub, st, trustedRoots, time.Now().UnixMilli()); err != nil {
			return fmt.Errorf("core: sender not verified: %w", err)
		}
	}

	// Presence is ephemeral (PROTOCOL.md §3): fan it out live, but never persist
	// it — it must not join the DAG or show up in history/sync.
	if ev.Type == cairnv1.EventType_PRESENCE {
		hub.broadcast(ev)
		return nil
	}

	stored, err := st.PutEvent(ev)
	if err != nil {
		return err
	}
	if stored {
		// Fold room/space membership into the materialized tables. The event is
		// already verified and durable, so a fold failure is a data problem to
		// surface — never a reason to reject an event that verifies.
		if isRoomStateEvent(ev.Type) {
			if err := applyRoomState(ev); err != nil {
				log.Printf("core: room-state fold failed for %x: %v", ev.EventId, err)
			}
		}
		hub.broadcast(ev)
	}
	return nil
}

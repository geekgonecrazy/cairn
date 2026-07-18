package core

import (
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// ErrAwaitingFounding is returned while a carrier has no household root yet: it
// cannot verify any sender, so it refuses events (default-deny) until the first
// attestation adopts a root. A client should publish its identity objects (which
// found the household) and retry — the same recoverable class as
// identity.ErrUnknownObject, distinct from the terminal rejections.
var ErrAwaitingFounding = errors.New("core: carrier has no household root yet")

// SubmitEvent is the write path: verify, persist, fan out. The server is
// convenience, not authority — it accepts an event only if it is internally
// valid (event.Verify) AND its sender chains to a trusted household root
// (identity.VerifySender). This is default-deny: a carrier that trusts no root
// refuses every event until founding (the first attestation) adopts one. On a
// genuinely new insert it broadcasts to realtime subscribers.
func SubmitEvent(ev *cairnv1.Event) error {
	if ev == nil {
		return fmt.Errorf("core: nil event")
	}
	if err := event.Verify(ev); err != nil {
		return err // ErrIDMismatch / ErrBadSig
	}

	// Chain gate. The sender must verify back to a trusted root. There is no
	// "open" mode: before a household is known the carrier cannot verify anyone,
	// so it refuses events rather than accepting on faith. Founding happens on
	// the identity plane (PutIdentityObject → MaybeAdoptRoot), not here.
	roots := trustAnchors()
	if len(roots) == 0 {
		return ErrAwaitingFounding
	}
	if _, err := identity.VerifySender(ev.SenderPub, st, roots, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("core: sender not verified: %w", err)
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

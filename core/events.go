package core

import (
	"fmt"
	"log"
	"time"

	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// SubmitEvent is the write path: verify, resolve the sender, persist, fan out.
//
// v2 (open relay): an event is accepted if it is internally valid (event.Verify)
// AND its sender resolves to a member root through a valid, non-revoked delegation
// chain (identity.VerifySender). There is NO household/trusted-root gate — trust
// is an edge decision, and admission control (a relay allow-list + invite key) is
// a later slice (docs/decisions.md §Trust model v2). A sender whose identity
// objects have not been published yet comes back as identity.ErrUnknownObject
// (recoverable: the client publishes its identity and retries); a revoked,
// expired, or forged chain is refused.
func SubmitEvent(ev *cairnv1.Event) error {
	if ev == nil {
		return fmt.Errorf("core: nil event")
	}
	if err := event.Verify(ev); err != nil {
		return err // ErrIDMismatch / ErrBadSig
	}

	// Resolve the sender's chain (device → member root, revocation enforced). This
	// is identity resolution, not trust: any valid member chain is accepted. A
	// refusal the operator cannot see is indistinguishable from a client bug, so
	// log it.
	if _, err := identity.VerifySender(ev.SenderPub, st, time.Now().UnixMilli()); err != nil {
		log.Printf("REJECT event type=%s sender=%x: %v", ev.Type, ev.SenderPub, err)
		return fmt.Errorf("core: sender not verified: %w", err)
	}

	// Presence is ephemeral (docs/protocol.md §3): fan it out live, but never
	// persist it — it must not join the DAG or show up in history/sync.
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

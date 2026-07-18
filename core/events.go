package core

import (
	"fmt"
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

	stored, err := st.PutEvent(ev)
	if err != nil {
		return err
	}
	if stored {
		hub.broadcast(ev)
	}
	return nil
}

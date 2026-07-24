package core

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/geekgonecrazy/cairn/config"
	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/identity"
	"github.com/geekgonecrazy/cairn/relay"
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
	// is identity resolution, not trust. A refusal the operator cannot see is
	// indistinguishable from a client bug, so log it.
	res, err := identity.VerifySender(ev.SenderPub, st, time.Now().UnixMilli())
	if err != nil {
		log.Printf("REJECT event type=%s sender=%x: %v", ev.Type, ev.SenderPub, err)
		return fmt.Errorf("core: sender not verified: %w", err)
	}

	// Relay access gate (slice 2): the sender's member must be carried by this
	// relay. Operational admission, not identity trust — see package relay.
	if err := enforceAccess(res.MemberPub); err != nil {
		log.Printf("REJECT event type=%s member=%x: %v", ev.Type, res.MemberPub, err)
		return err
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

// ErrNotAllowed is returned when the relay is invite-only and the sender's member
// root is not on the allow-list. Terminal for that sender until an invite or the
// operator admits them.
var ErrNotAllowed = errors.New("core: sender not admitted to this relay (needs an invite)")

// enforceAccess is the relay allow-list gate. When the relay is OPEN
// (config.RequireInvite=false) it admits any resolved sender and records them
// trust-on-first-use, so the operator can see who's been carried and switch to
// invite-only later. When invite-only, the member must already be on the list.
func enforceAccess(memberPub []byte) error {
	ok, err := st.IsAllowed(memberPub)
	if err != nil {
		return err
	}
	if ok {
		return nil
	}
	if !config.Config.RequireInvite {
		return st.AllowMember(memberPub, "tofu", time.Now().UnixMilli())
	}
	return ErrNotAllowed
}

// RedeemInvite verifies a relay-signed invite, marks it consumed (single-use),
// and adds memberPub to the allow-list. Backs the RedeemInvite RPC so a freshly
// created identity can admit itself with an invite the operator handed out.
func RedeemInvite(inviteStr string, memberPub []byte) error {
	if len(memberPub) != ed25519.PublicKeySize {
		return fmt.Errorf("core: member_pub must be %d bytes", ed25519.PublicKeySize)
	}
	inv, err := relay.ParseInvite(inviteStr)
	if err != nil {
		return err
	}
	if !inv.Verify(relayPub) {
		return fmt.Errorf("core: invite is not signed by this relay")
	}
	now := time.Now().UnixMilli()
	if inv.ExpiresAt != 0 && now > inv.ExpiresAt {
		return fmt.Errorf("core: invite has expired")
	}
	consumed, err := st.ConsumeInvite(inv.ID, memberPub, now)
	if err != nil {
		return err
	}
	if !consumed {
		return fmt.Errorf("core: invite has already been used")
	}
	return st.AllowMember(memberPub, "invite", now)
}

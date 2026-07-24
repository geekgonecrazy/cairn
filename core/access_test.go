package core

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"github.com/geekgonecrazy/cairn/config"
	"github.com/geekgonecrazy/cairn/identity"
	"github.com/geekgonecrazy/cairn/relay"
)

// The relay allow-list gate: open admits trust-on-first-use; invite-only refuses
// a stranger until an invite (single-use) or the operator admits them.
func TestAccessGate(t *testing.T) {
	setTestStore(t)
	pub, priv, err := relay.LoadOrCreateKey(st)
	if err != nil {
		t.Fatal(err)
	}
	relayPub, relayPriv = pub, priv
	t.Cleanup(func() { config.Config.RequireInvite = false })

	member, _ := identity.GenerateKey()

	// Open relay (default): first contact TOFU-admits and records it.
	config.Config.RequireInvite = false
	if err := enforceAccess(member.Pub); err != nil {
		t.Fatalf("open relay rejected a valid sender: %v", err)
	}
	if ok, _ := st.IsAllowed(member.Pub); !ok {
		t.Fatal("TOFU did not record the admitted member")
	}

	// Invite-only: a stranger is refused.
	config.Config.RequireInvite = true
	stranger, _ := identity.GenerateKey()
	if err := enforceAccess(stranger.Pub); err == nil {
		t.Fatal("invite-only relay admitted a stranger")
	}

	// Redeeming a relay-signed invite admits them.
	inv, _ := relay.NewInvite(relayPriv, 0)
	code, _ := inv.Encode()
	if err := RedeemInvite(code, stranger.Pub); err != nil {
		t.Fatalf("redeem invite: %v", err)
	}
	if err := enforceAccess(stranger.Pub); err != nil {
		t.Fatalf("an admitted member was rejected: %v", err)
	}

	// Single-use: the same invite cannot be redeemed again.
	other, _ := identity.GenerateKey()
	if err := RedeemInvite(code, other.Pub); err == nil {
		t.Fatal("a single-use invite was redeemed twice")
	}

	// An invite not signed by this relay is refused.
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	foreign, _ := relay.NewInvite(otherPriv, 0)
	foreignCode, _ := foreign.Encode()
	if err := RedeemInvite(foreignCode, other.Pub); err == nil {
		t.Fatal("an invite from a different relay was accepted")
	}
}

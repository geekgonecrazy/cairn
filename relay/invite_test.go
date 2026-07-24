package relay

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
)

func TestInviteSignVerifyRoundTrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	inv, err := NewInvite(priv, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !inv.Verify(pub) {
		t.Fatal("fresh invite does not verify")
	}

	code, err := inv.Encode()
	if err != nil {
		t.Fatal(err)
	}
	back, err := ParseInvite(code)
	if err != nil {
		t.Fatal(err)
	}
	if !back.Verify(pub) {
		t.Fatal("round-tripped invite does not verify")
	}

	// A different relay key must not verify it.
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	if back.Verify(otherPub) {
		t.Fatal("invite verified under the wrong relay key")
	}

	// Tampering with the expiry breaks the signature.
	back.ExpiresAt = 999
	if back.Verify(pub) {
		t.Fatal("tampered invite verified")
	}
}

func TestParseInviteRejectsGarbage(t *testing.T) {
	for _, s := range []string{"", "https://x", "cairn:invite:1:!!!", "cairn:pair:1:abc"} {
		if _, err := ParseInvite(s); err == nil {
			t.Errorf("ParseInvite(%q) = nil error, want rejection", s)
		}
	}
}

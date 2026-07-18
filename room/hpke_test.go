package room

import (
	"bytes"
	"testing"

	"github.com/geekgonecrazy/cairn/identity"
)

func TestWrapUnwrap_RoundTrip(t *testing.T) {
	kp, _ := identity.GenerateKey()
	roomKey, _ := NewRoomKey()

	blob, err := WrapKey(kp.Pub, roomKey)
	if err != nil {
		t.Fatalf("wrap: %v", err)
	}
	got, err := UnwrapKey(kp.Priv, blob)
	if err != nil {
		t.Fatalf("unwrap: %v", err)
	}
	if !bytes.Equal(got, roomKey) {
		t.Fatal("unwrapped key != original")
	}
}

func TestUnwrap_WrongRecipientFails(t *testing.T) {
	kp, _ := identity.GenerateKey()
	other, _ := identity.GenerateKey()
	roomKey, _ := NewRoomKey()

	blob, _ := WrapKey(kp.Pub, roomKey)
	if _, err := UnwrapKey(other.Priv, blob); err == nil {
		t.Fatal("unwrap with wrong recipient key should fail")
	}
}

func TestEdToX25519_PublicMatchesPrivate(t *testing.T) {
	// The X25519 pub derived from the Ed25519 pub must equal the one derived
	// from the Ed25519 priv's scalar (else wrap/unwrap can't agree).
	kp, _ := identity.GenerateKey()
	xPub, err := EdToX25519Public(kp.Pub)
	if err != nil {
		t.Fatal(err)
	}
	if len(xPub) != 32 {
		t.Fatalf("x25519 pub len = %d", len(xPub))
	}
	xPriv := EdToX25519Private(kp.Priv)
	if len(xPriv) != 32 {
		t.Fatalf("x25519 priv len = %d", len(xPriv))
	}
}

func TestMemberAdd_EncodeDecode(t *testing.T) {
	adder, _ := identity.GenerateKey()
	newMember, _ := identity.GenerateKey()
	roomKey, _ := NewRoomKey()

	wrappedAdder, _ := WrapKey(adder.Pub, roomKey)
	wrappedNew, _ := WrapKey(newMember.Pub, roomKey)

	ma := &MemberAdd{
		MemberPub: newMember.Pub,
		Role:      "member",
		Epoch:     2,
		WrappedKeys: WrappedKeys{
			string(hexish(adder.Pub)):     wrappedAdder,
			string(hexish(newMember.Pub)): wrappedNew,
		},
	}
	b, err := EncodePayload(ma)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeMemberAdd(b)
	if err != nil {
		t.Fatal(err)
	}
	if got.Epoch != 2 || got.Role != "member" || len(got.WrappedKeys) != 2 {
		t.Fatalf("member_add round-trip mismatch: %+v", got)
	}
	// The new member can unwrap their entry.
	rk, err := UnwrapKey(newMember.Priv, got.WrappedKeys[string(hexish(newMember.Pub))])
	if err != nil || !bytes.Equal(rk, roomKey) {
		t.Fatalf("new member could not unwrap: %v", err)
	}
}

// hexish gives a short stable string key for a pubkey in tests.
func hexish(b []byte) []byte {
	const h = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = h[c>>4]
		out[i*2+1] = h[c&0xf]
	}
	return out
}

package approval

import (
	"crypto/ed25519"
	"testing"

	"github.com/geekgonecrazy/cairn/identity"
)

// A Grant's whole purpose is to verify STANDALONE — a broker holds a bare blob
// with no event envelope to say what it is. These tests pin that the signed
// type tag, not the surrounding context, is what tells a Grant from a Deny.
//
// The failure this prevents is the expensive one: a broker reading a refusal as
// an approval and minting a credential.

func keyPair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func TestArtifactTagsAreStampedAndEnforced(t *testing.T) {
	approver, approverPriv := keyPair(t)
	agent, _ := keyPair(t)

	grant := &Grant{
		RequestID:      []byte("req-1"),
		CapabilityHash: []byte("cap-hash"),
		AgentPub:       agent,
		ApproverPub:    approver,
		IssuedAt:       1,
		ExpiresAt:      1 << 40,
	}
	if err := Sign(grant, approverPriv); err != nil {
		t.Fatalf("sign grant: %v", err)
	}
	if grant.Type != TypeGrant {
		t.Fatalf("Sign did not stamp the grant tag: %q", grant.Type)
	}
	if err := VerifyGrant(grant); err != nil {
		t.Fatalf("grant does not self-verify: %v", err)
	}

	deny := &Deny{
		RequestID:   []byte("req-1"),
		ApproverPub: approver,
		Reason:      "no",
		IssuedAt:    1,
	}
	if err := Sign(deny, approverPriv); err != nil {
		t.Fatalf("sign deny: %v", err)
	}
	if deny.Type != TypeDeny {
		t.Fatalf("deny tag = %q", deny.Type)
	}

	// A relabelled grant must not verify.
	relabelled := *grant
	relabelled.Type = TypeDeny
	if err := VerifyGrant(&relabelled); err == nil {
		t.Error("a grant claiming to be a deny verified as a grant")
	}

	// Untagged (pre-change) artifacts must not verify either.
	untagged := *grant
	untagged.Type = ""
	if err := VerifyGrant(&untagged); err == nil {
		t.Error("an untagged grant verified")
	}
}

// The critical direction: a signed DENY, re-read as a Grant, must never verify.
func TestDenyCannotBeReadAsGrant(t *testing.T) {
	approver, approverPriv := keyPair(t)

	deny := &Deny{
		RequestID:   []byte("req-9"),
		ApproverPub: approver,
		Reason:      "absolutely not",
		IssuedAt:    5,
	}
	if err := Sign(deny, approverPriv); err != nil {
		t.Fatal(err)
	}
	blob, err := identity.Marshal(deny)
	if err != nil {
		t.Fatal(err)
	}

	// Exactly what a broker would do with a blob it assumed was a grant.
	var asGrant Grant
	if err := identity.Unmarshal(blob, &asGrant); err == nil {
		if verr := VerifyGrant(&asGrant); verr == nil {
			t.Fatal("a signed DENY verified as a GRANT — a broker would mint on a refusal")
		}
	}

	// And dispatching on the tag labels it correctly.
	tag, err := ArtifactType(blob)
	if err != nil {
		t.Fatalf("ArtifactType: %v", err)
	}
	if tag != TypeDeny {
		t.Errorf("ArtifactType = %q, want %q", tag, TypeDeny)
	}
}

func TestArtifactTypeRejectsUntagged(t *testing.T) {
	if _, err := ArtifactType([]byte{0xff, 0xff}); err == nil {
		t.Error("undecodable bytes produced a type")
	}
	blob, _ := identity.Marshal(map[string]string{"a": "b"})
	if _, err := ArtifactType(blob); err == nil {
		t.Error("an untagged artifact produced a type")
	}
}

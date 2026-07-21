package approval

import (
	"bytes"
	"errors"
	"testing"

	"github.com/geekgonecrazy/cairn/identity"
)

func mustKey(t *testing.T) identity.KeyPair {
	t.Helper()
	kp, err := identity.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	return kp
}

func sampleCap() *Capability {
	return &Capability{
		Name:   "vent.actuate",
		Params: map[string]string{"target": "gh_roof"},
		Scope:  "30 min · this vent only",
		TaskID: "task-42",
	}
}

func TestApprovalFlow_RequestGrant(t *testing.T) {
	agent := mustKey(t)
	human := mustKey(t)

	req, err := NewCapabilityRequest([]byte("req-1"), agent, sampleCap(), 1000, 9000)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyRequest(req); err != nil {
		t.Fatalf("agent's own request should verify: %v", err)
	}

	grant, err := Approve(req, human, 2000, 8000)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyGrant(grant); err != nil {
		t.Fatalf("human's grant should verify: %v", err)
	}
	if err := GrantCovers(grant, req); err != nil {
		t.Fatalf("grant should cover the request it approved: %v", err)
	}
}

// The load-bearing property: the grant is PORTABLE. Given only the artifact
// bytes and the approver's pubkey — no room key, no Cairn store, no identity
// log, no server — an external broker can verify the human really said yes.
func TestGrant_VerifiesStandaloneOutsideCairn(t *testing.T) {
	agent := mustKey(t)
	human := mustKey(t)
	req, _ := NewCapabilityRequest([]byte("req-2"), agent, sampleCap(), 1000, 9000)
	grant, _ := Approve(req, human, 2000, 8000)

	// Serialize as it would travel out of the room, then rehydrate cold.
	wire, err := Encode(grant)
	if err != nil {
		t.Fatal(err)
	}
	var cold Grant
	if err := identity.Unmarshal(wire, &cold); err != nil {
		t.Fatal(err)
	}
	if err := VerifyGrant(&cold); err != nil {
		t.Fatalf("cold-rehydrated grant must verify standalone: %v", err)
	}
	if !bytes.Equal(cold.ApproverPub, human.Pub) {
		t.Fatal("grant must name the approver so a broker can apply policy")
	}
	if cold.Expired(3000) {
		t.Fatal("should not be expired before expires_at")
	}
	if !cold.Expired(9999) {
		t.Fatal("must be expired after expires_at")
	}
}

func TestGrant_TamperedCapabilityFails(t *testing.T) {
	agent := mustKey(t)
	human := mustKey(t)
	req, _ := NewCapabilityRequest([]byte("req-3"), agent, sampleCap(), 1000, 9000)
	grant, _ := Approve(req, human, 2000, 8000)

	// Swap the capability after the human signed → the hash no longer matches.
	evil := sampleCap()
	evil.Name = "door.unlock"
	_, evilPayload, _ := MarshalCapability(evil)
	h := HashPayload(evilPayload)
	tampered := *req
	tampered.Payload = evilPayload
	tampered.PayloadHash = h[:]

	if err := GrantCovers(grant, &tampered); !errors.Is(err, ErrRequestMismatch) {
		t.Fatalf("grant must not cover a swapped capability, got %v", err)
	}
}

func TestGrant_CannotBeReplayedByAnotherAgent(t *testing.T) {
	agent := mustKey(t)
	other := mustKey(t)
	human := mustKey(t)
	req, _ := NewCapabilityRequest([]byte("req-4"), agent, sampleCap(), 1000, 9000)
	grant, _ := Approve(req, human, 2000, 8000)

	// A different agent tries to reuse the grant for its own identical request.
	otherReq, _ := NewCapabilityRequest([]byte("req-4"), other, sampleCap(), 1000, 9000)
	if err := GrantCovers(grant, otherReq); !errors.Is(err, ErrAgentMismatch) {
		t.Fatalf("grant is agent-bound; want ErrAgentMismatch, got %v", err)
	}
}

func TestGrant_ForgedSignatureFails(t *testing.T) {
	agent := mustKey(t)
	human := mustKey(t)
	attacker := mustKey(t)
	req, _ := NewCapabilityRequest([]byte("req-5"), agent, sampleCap(), 1000, 9000)

	// Attacker signs a grant but claims it came from the human.
	forged := &Grant{
		RequestID:   req.RequestID,
		PayloadHash: req.PayloadHash,
		AgentPub:    req.AgentPub,
		ApproverPub: human.Pub, // lies about who approved
		IssuedAt:    2000,
		ExpiresAt:   8000,
	}
	if err := Sign(forged, attacker.Priv); err != nil {
		t.Fatal(err)
	}
	if err := VerifyGrant(forged); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("a broker must reject a forged grant; got %v", err)
	}
}

func TestDeny_Verifies(t *testing.T) {
	agent := mustKey(t)
	human := mustKey(t)
	req, _ := NewCapabilityRequest([]byte("req-6"), agent, sampleCap(), 1000, 9000)
	d, err := Refuse(req, human, "not while I'm away", 2500)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyDeny(d); err != nil {
		t.Fatalf("denial should verify: %v", err)
	}
}

func TestHashCapability_Deterministic(t *testing.T) {
	a, err := HashCapability(sampleCap())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := HashCapability(sampleCap())
	if a != b {
		t.Fatal("capability hash must be deterministic")
	}
}

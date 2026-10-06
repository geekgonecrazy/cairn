package sqlite

import (
	"testing"

	"github.com/geekgonecrazy/cairn/identity"
)

// The sqlite store IS an identity.Resolver, so the vouch proof must work
// through persisted state, not just the in-memory log: vouches filed by many
// devices must all come back, withdrawals must come back, and multiple
// attestations for one member must select the same winner VerifySender would
// pick anywhere else.
func TestStore_AgentVouchProofEndToEnd(t *testing.T) {
	s := newTestStore(t)
	now := int64(1_700_000_000_000)

	opMember, _ := identity.GenerateKey()
	opDev, _ := identity.GenerateKey()
	agMember, _ := identity.GenerateKey()
	agDev, _ := identity.GenerateKey()

	put := func(obj any) {
		t.Helper()
		var err error
		switch o := obj.(type) {
		case *identity.IdentityAttestation:
			err = s.PutAttestation(o)
		case *identity.DeviceDelegation:
			err = s.PutDeviceDelegation(o)
		case *identity.AgentDelegation:
			err = s.PutAgentDelegation(o)
		case *identity.VouchWithdraw:
			err = s.PutVouchWithdraw(o)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	attest := func(kp identity.KeyPair, kind identity.Kind, name string, operatedBy []byte, at int64) {
		t.Helper()
		a, err := identity.NewSelfAttestation(kp, kind, name, operatedBy, at)
		if err != nil {
			t.Fatal(err)
		}
		put(a)
	}
	delegate := func(child, parent identity.KeyPair) {
		t.Helper()
		req, err := identity.NewPairingRequest(child.Pub, "x")
		if err != nil {
			t.Fatal(err)
		}
		dd, err := identity.ApprovePairing(req, parent.Pub, parent.Priv, now, 0)
		if err != nil {
			t.Fatal(err)
		}
		put(dd)
	}

	attest(opMember, identity.KindHuman, "Sam", nil, now)
	delegate(opDev, opMember)
	attest(agMember, identity.KindAgent, "Helper", opMember.Pub, now)
	delegate(agDev, agMember)

	// Unproven before any vouch — and it resolves, not errors.
	res, err := identity.VerifySender(agDev.Pub, s, now)
	if err != nil {
		t.Fatalf("unvouched agent does not resolve: %v", err)
	}
	if res.AgentProof != identity.AgentProofUnproven {
		t.Fatalf("proof = %q, want unproven", res.AgentProof)
	}

	d, err := identity.IssueAgentVouch(agMember.Pub, opDev.Pub, opDev.Priv, opMember.Pub, now, 0)
	if err != nil {
		t.Fatal(err)
	}
	put(d)

	res, err = identity.VerifySender(agDev.Pub, s, now)
	if err != nil {
		t.Fatal(err)
	}
	if res.AgentProof != identity.AgentProofProven || res.Vouches != 1 {
		t.Fatalf("proof = %q vouches = %d, want proven/1", res.AgentProof, res.Vouches)
	}

	// A rename supersedes through the store too: latest issued_at wins.
	attest(agMember, identity.KindAgent, "Helper v2", opMember.Pub, now+1)
	att, ok := s.Attestation(agMember.Pub)
	if !ok {
		t.Fatal("attestation missing after rename")
	}
	if att.DisplayName != "Helper v2" {
		t.Fatalf("name = %q, want Helper v2", att.DisplayName)
	}

	// Withdraw the vouch: unproven again, still resolving.
	w, err := identity.WithdrawVouch(agMember.Pub, opDev.Pub, opDev.Priv, now+2)
	if err != nil {
		t.Fatal(err)
	}
	put(w)
	res, err = identity.VerifySender(agDev.Pub, s, now+2)
	if err != nil {
		t.Fatal(err)
	}
	if res.AgentProof != identity.AgentProofUnproven {
		t.Fatalf("after withdraw: proof = %q, want unproven", res.AgentProof)
	}
}

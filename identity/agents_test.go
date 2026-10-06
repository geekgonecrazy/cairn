package identity

import (
	"bytes"
	"testing"
)

// Agent vouches turn an agent's self-declared operated_by into a proven fact.
// These tests pin the whole story: minting, multi-device redundancy, transfer,
// withdrawal, expiry, and the order-independent attestation selection they sit
// on. See docs/adrs/0017-agent-delegation.md.

// agentSetup builds an operator (member + one device) and an agent (member +
// self-attestation naming the operator + one device), all registered in a
// fresh log. Returns operator member/dev, agent member/dev.
func agentSetup(t *testing.T) (opMember, opDev, agMember, agDev KeyPair, log *DeviceLog) {
	t.Helper()
	log = NewDeviceLog()

	var err error
	opMember, err = GenerateKey()
	must(t, err)
	opDev, err = GenerateKey()
	must(t, err)
	agMember, err = GenerateKey()
	must(t, err)
	agDev, err = GenerateKey()
	must(t, err)

	opAtt, err := NewSelfAttestation(opMember, KindHuman, "Sam", nil, testNow)
	must(t, err)
	must(t, log.AddAttestation(opAtt))
	opDD, err := ApprovePairing(mustPairing(t, opDev.Pub, "laptop"), opMember.Pub, opMember.Priv, testNow, 0)
	must(t, err)
	must(t, log.AddDelegation(opDD))

	agAtt, err := NewSelfAttestation(agMember, KindAgent, "Helper", opMember.Pub, testNow)
	must(t, err)
	must(t, log.AddAttestation(agAtt))
	agDD, err := ApprovePairing(mustPairing(t, agDev.Pub, "self"), agMember.Pub, agMember.Priv, testNow, 0)
	must(t, err)
	must(t, log.AddDelegation(agDD))

	return opMember, opDev, agMember, agDev, log
}

// vouchFromDevice mints and files a vouch of agent by a device key.
func vouchFromDevice(t *testing.T, log *DeviceLog, agentPub PubKey, dev KeyPair, operatorPub PubKey, issuedAt int64) *AgentDelegation {
	t.Helper()
	d, err := IssueAgentVouch(agentPub, dev.Pub, dev.Priv, operatorPub, issuedAt, 0)
	must(t, err)
	must(t, log.AddAgentDelegation(d))
	return d
}

func TestVouchSelfVerifies(t *testing.T) {
	op, _ := GenerateKey()
	dev, _ := GenerateKey()
	ag, _ := GenerateKey()

	d, err := IssueAgentVouch(ag.Pub, dev.Pub, dev.Priv, op.Pub, testNow, 0)
	must(t, err)
	if !VerifyAgentDelegation(d) {
		t.Fatal("vouch does not self-verify")
	}

	// Tampering with the named operator breaks the signature.
	bad := *d
	bad.OperatorPub = dev.Pub
	if VerifyAgentDelegation(&bad) {
		t.Fatal("vouch with tampered operator verifies")
	}

	// Minting validation.
	if _, err := IssueAgentVouch(ag.Pub, ag.Pub, dev.Priv, op.Pub, testNow, 0); err == nil {
		t.Fatal("self-vouch was minted")
	}
	if _, err := IssueAgentVouch(ag.Pub, dev.Pub, dev.Priv, nil, testNow, 0); err == nil {
		t.Fatal("vouch without an operator was minted")
	}
	if _, err := IssueAgentVouch(ag.Pub, dev.Pub, dev.Priv, op.Pub, testNow, testNow); err == nil {
		t.Fatal("vouch with expires_at <= issued_at was minted")
	}
}

func TestWithdrawIsSelfAuthorityOnly(t *testing.T) {
	_, opDev, agMember, _, log := agentSetup(t)
	w, err := WithdrawVouch(agMember.Pub, opDev.Pub, opDev.Priv, testNow+1)
	must(t, err)
	if !VerifyVouchWithdraw(w) {
		t.Fatal("withdrawal does not self-verify")
	}
	must(t, log.AddVouchWithdraw(w))

	// A withdrawal signed by anyone but the delegator is not even filed: it
	// names a signer that is not its subject.
	stranger, _ := GenerateKey()
	w2 := &VouchWithdraw{AgentPub: agMember.Pub, DelegatorPub: opDev.Pub, WithdrawnAt: testNow + 1}
	must(t, Sign(w2, stranger.Priv))
	if err := log.AddVouchWithdraw(w2); err == nil {
		t.Fatal("withdrawal signed by a stranger was filed")
	}
}

// An agent with no vouch still RESOLVES — unproven is a proof state, not a
// chain error. The submit path must not refuse it; callers handle the state.
func TestUnvouchedAgentResolvesUnproven(t *testing.T) {
	opMember, _, agMember, agDev, log := agentSetup(t)
	_, _ = opMember, agMember

	res, err := VerifySender(agDev.Pub, log, testNow)
	if err != nil {
		t.Fatalf("unvouched agent does not resolve: %v", err)
	}
	if res.Kind != KindAgent {
		t.Fatalf("kind = %q, want agent", res.Kind)
	}
	if res.AgentProof != AgentProofUnproven {
		t.Fatalf("proof = %q, want unproven", res.AgentProof)
	}
	if !bytes.Equal(res.OperatedBy, opMember.Pub) {
		t.Fatal("operated_by does not name the operator")
	}
}

func TestVouchedAgentIsProven(t *testing.T) {
	opMember, opDev, agMember, agDev, log := agentSetup(t)

	vouchFromDevice(t, log, agMember.Pub, opDev, opMember.Pub, testNow)

	res, err := VerifySender(agDev.Pub, log, testNow)
	if err != nil {
		t.Fatalf("vouched agent does not resolve: %v", err)
	}
	if res.AgentProof != AgentProofProven {
		t.Fatalf("proof = %q, want proven", res.AgentProof)
	}
	if res.Vouches != 1 {
		t.Fatalf("vouches = %d, want 1", res.Vouches)
	}
}

// The redundancy story: vouch from two devices; revoking one removes one
// vouch, and the agent stays proven on the other.
func TestMultiVouchSurvivesOneRevocation(t *testing.T) {
	opMember, opDev, agMember, agDev, log := agentSetup(t)

	opDev2, _ := GenerateKey()
	dd2, err := ApprovePairing(mustPairing(t, opDev2.Pub, "phone"), opMember.Pub, opMember.Priv, testNow, 0)
	must(t, err)
	must(t, log.AddDelegation(dd2))

	vouchFromDevice(t, log, agMember.Pub, opDev, opMember.Pub, testNow)
	vouchFromDevice(t, log, agMember.Pub, opDev2, opMember.Pub, testNow)

	res, err := VerifySender(agDev.Pub, log, testNow)
	must(t, err)
	if res.AgentProof != AgentProofProven || res.Vouches != 2 {
		t.Fatalf("proof = %q vouches = %d, want proven/2", res.AgentProof, res.Vouches)
	}

	// Revoke the first device: its vouch dies, the agent lives on the second.
	dr, err := RevokeDevice(opDev.Pub, opMember.Pub, opMember.Priv, testNow+1)
	must(t, err)
	must(t, log.AddRevoke(dr))

	res, err = VerifySender(agDev.Pub, log, testNow+2)
	must(t, err)
	if res.AgentProof != AgentProofProven || res.Vouches != 1 {
		t.Fatalf("after one revoke: proof = %q vouches = %d, want proven/1",
			res.AgentProof, res.Vouches)
	}

	// Revoke the second device too: no vouch survives, the agent is unproven —
	// but it still resolves.
	dr2, err := RevokeDevice(opDev2.Pub, opMember.Pub, opMember.Priv, testNow+3)
	must(t, err)
	must(t, log.AddRevoke(dr2))

	res, err = VerifySender(agDev.Pub, log, testNow+4)
	must(t, err)
	if res.AgentProof != AgentProofUnproven {
		t.Fatalf("after all revokes: proof = %q, want unproven", res.AgentProof)
	}
}

// Withdrawing the only vouch un-proves the agent; a LATER re-vouch from the
// same delegator is live again (withdraw kills vouches issued at or before
// it), so withdrawing can never permanently lock an operator out of re-proving.
func TestWithdrawAndReVouch(t *testing.T) {
	opMember, opDev, agMember, agDev, log := agentSetup(t)

	vouchFromDevice(t, log, agMember.Pub, opDev, opMember.Pub, testNow)

	w, err := WithdrawVouch(agMember.Pub, opDev.Pub, opDev.Priv, testNow+1)
	must(t, err)
	must(t, log.AddVouchWithdraw(w))

	if res, err := VerifySender(agDev.Pub, log, testNow+2); err != nil || res.AgentProof != AgentProofUnproven {
		t.Fatalf("after withdraw: res=%+v err=%v, want unproven", res, err)
	}

	// A vouch issued BEFORE the withdrawal stays dead; one issued after lives.
	stale, err := IssueAgentVouch(agMember.Pub, opDev.Pub, opDev.Priv, opMember.Pub, testNow, 0)
	must(t, err)
	must(t, log.AddAgentDelegation(stale))
	if res, _ := VerifySender(agDev.Pub, log, testNow+2); res.AgentProof != AgentProofUnproven {
		t.Fatal("pre-withdrawal vouch came back to life")
	}

	fresh, err := IssueAgentVouch(agMember.Pub, opDev.Pub, opDev.Priv, opMember.Pub, testNow+2, 0)
	must(t, err)
	must(t, log.AddAgentDelegation(fresh))
	res, err := VerifySender(agDev.Pub, log, testNow+2)
	must(t, err)
	if res.AgentProof != AgentProofProven {
		t.Fatalf("after re-vouch: proof = %q, want proven", res.AgentProof)
	}
}

func TestExpiredVouchIsNotProof(t *testing.T) {
	opMember, opDev, agMember, agDev, log := agentSetup(t)

	d, err := IssueAgentVouch(agMember.Pub, opDev.Pub, opDev.Priv, opMember.Pub, testNow, testNow+100)
	must(t, err)
	must(t, log.AddAgentDelegation(d))

	if res, _ := VerifySender(agDev.Pub, log, testNow+50); res.AgentProof != AgentProofProven {
		t.Fatal("live vouch does not prove")
	}
	if res, _ := VerifySender(agDev.Pub, log, testNow+101); res.AgentProof != AgentProofUnproven {
		t.Fatal("expired vouch still proves")
	}
}

// A vouch that names an operator the agent does not claim is void — this is
// what stops anyone vouching anyone's agent to themselves (the hijack), and
// what voids old vouches on transfer without the old owner lifting a finger.
func TestVouchOperatorMismatchIsVoid(t *testing.T) {
	opMember, _, agMember, agDev, log := agentSetup(t)

	stranger, _ := GenerateKey()
	strAtt, err := NewSelfAttestation(stranger, KindHuman, "Mallory", nil, testNow)
	must(t, err)
	must(t, log.AddAttestation(strAtt))
	strDev, _ := GenerateKey()
	strDD, err := ApprovePairing(mustPairing(t, strDev.Pub, "x"), stranger.Pub, stranger.Priv, testNow, 0)
	must(t, err)
	must(t, log.AddDelegation(strDD))

	vouchFromDevice(t, log, agMember.Pub, strDev, stranger.Pub, testNow)

	res, err := VerifySender(agDev.Pub, log, testNow)
	must(t, err)
	if res.AgentProof != AgentProofUnproven {
		t.Fatalf("stranger's vouch proves: %+v", res)
	}
	if !bytes.Equal(res.OperatedBy, opMember.Pub) {
		t.Fatal("operator changed under a mismatched vouch")
	}
}

// Transfer: the agent re-attests to a new operator, the new operator vouches,
// and the old operator's vouch voids itself by no longer matching. The old
// owner cannot hold on; the new owner could not have taken without the agent's
// key (only it can change operated_by).
func TestTransferByReattestation(t *testing.T) {
	opMember, opDev, agMember, agDev, log := agentSetup(t)
	vouchFromDevice(t, log, agMember.Pub, opDev, opMember.Pub, testNow)

	newOp, _ := GenerateKey()
	newAtt, err := NewSelfAttestation(newOp, KindHuman, "Pat", nil, testNow)
	must(t, err)
	must(t, log.AddAttestation(newAtt))
	newDev, _ := GenerateKey()
	newDD, err := ApprovePairing(mustPairing(t, newDev.Pub, "tablet"), newOp.Pub, newOp.Priv, testNow, 0)
	must(t, err)
	must(t, log.AddDelegation(newDD))

	// The agent moves itself: a newer attestation naming the new operator.
	agAtt2, err := NewSelfAttestation(agMember, KindAgent, "Helper", newOp.Pub, testNow+1)
	must(t, err)
	must(t, log.AddAttestation(agAtt2))
	vouchFromDevice(t, log, agMember.Pub, newDev, newOp.Pub, testNow+1)

	res, err := VerifySender(agDev.Pub, log, testNow+2)
	must(t, err)
	if res.AgentProof != AgentProofProven {
		t.Fatalf("transferred agent not proven: %+v", res)
	}
	if !bytes.Equal(res.OperatedBy, newOp.Pub) {
		t.Fatal("operator did not move to the new owner")
	}
	if res.Vouches != 1 {
		t.Fatalf("vouches = %d, want 1 (old owner's vouch must be void)", res.Vouches)
	}
}

// A vouch signed by the operator root itself is valid without a device walk:
// the durable, words-issued vouch the cascade cannot touch.
func TestRootSignedVouch(t *testing.T) {
	opMember, _, agMember, agDev, log := agentSetup(t)

	d, err := IssueAgentVouch(agMember.Pub, opMember.Pub, opMember.Priv, opMember.Pub, testNow, 0)
	must(t, err)
	must(t, log.AddAgentDelegation(d))

	res, err := VerifySender(agDev.Pub, log, testNow)
	must(t, err)
	if res.AgentProof != AgentProofProven || res.Vouches != 1 {
		t.Fatalf("root-signed vouch: proof = %q vouches = %d", res.AgentProof, res.Vouches)
	}
}

// Attestation selection is order-independent: latest issued_at wins the
// profile, earliest issuance keeps the kind, no matter the insert order.
func TestAttestationSupersessionIsOrderIndependent(t *testing.T) {
	member, _ := GenerateKey()

	rename := func(name string, at int64) *IdentityAttestation {
		a, err := NewSelfAttestation(member, KindHuman, name, nil, at)
		must(t, err)
		return a
	}

	build := func(order ...*IdentityAttestation) *DeviceLog {
		log := NewDeviceLog()
		for _, a := range order {
			must(t, log.AddAttestation(a))
		}
		return log
	}

	old, newer := rename("Sam", testNow), rename("Samuel", testNow+1)
	for name, log := range map[string]*DeviceLog{
		"chronological": build(old, newer),
		"reversed":      build(newer, old),
	} {
		att, ok := log.Attestation(member.Pub)
		if !ok {
			t.Fatalf("%s: no attestation selected", name)
		}
		if att.DisplayName != "Samuel" {
			t.Fatalf("%s: name = %q, want Samuel", name, att.DisplayName)
		}
	}

	// kind is earliest-wins: a later attestation cannot change it, whichever
	// arrives first.
	kindChange, err := NewSelfAttestation(member, KindService, "Samuel", nil, testNow+2)
	must(t, err)
	for name, log := range map[string]*DeviceLog{
		"chronological": build(old, newer, kindChange),
		"kind-first":    build(kindChange, old, newer),
	} {
		att, ok := log.Attestation(member.Pub)
		if !ok {
			t.Fatalf("%s: no attestation selected", name)
		}
		if att.Kind != KindHuman {
			t.Fatalf("%s: kind = %q, want human (earliest-wins)", name, att.Kind)
		}
		if att.DisplayName != "Samuel" {
			t.Fatalf("%s: name = %q, want Samuel", name, att.DisplayName)
		}
	}
}

// Non-agents never get a proof state — the question does not arise.
func TestNonAgentProofIsNA(t *testing.T) {
	member, log := selfAttested(t)
	dev := pairDevice(t, log, member, "laptop")

	res, err := VerifySender(dev.Pub, log, testNow)
	must(t, err)
	if res.AgentProof != AgentProofNA || res.Vouches != 0 {
		t.Fatalf("human proof = %q/%d, want na/0", res.AgentProof, res.Vouches)
	}
}

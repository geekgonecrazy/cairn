package identity

import "testing"

// Identity-log objects carry a signed `type` tag, so the carrier (controllers/
// identity.go) dispatches on it and then verifies the object as exactly that
// shape. A signature over one type must never check out as another — these tests
// pin that property.
//
// If it ever breaks, a client could publish a session delegation that the server
// files as a device delegation, promoting a per-tab key to a device.

func TestVerifiersRejectOtherObjectTypes(t *testing.T) {
	member, _ := GenerateKey()
	device, _ := GenerateKey()
	session, _ := GenerateKey()

	att, err := NewSelfAttestation(member, KindHuman, "Sam", nil, testNow)
	if err != nil {
		t.Fatalf("self-attest: %v", err)
	}
	dd, err := ApprovePairing(
		mustPairing(t, device.Pub, "laptop"), member.Pub, member.Priv, testNow, 0)
	if err != nil {
		t.Fatalf("delegation: %v", err)
	}
	sd := &SessionDelegation{
		SessionPub: session.Pub, DevicePub: device.Pub,
		Scope: "chat", ExpiresAt: testNow + 1000,
	}
	if err := Sign(sd, device.Priv); err != nil {
		t.Fatal(err)
	}
	dr, err := RevokeDevice(device.Pub, member.Pub, member.Priv, testNow+1)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	ad, err := IssueAgentVouch(device.Pub, member.Pub, member.Priv, member.Pub, testNow, 0)
	if err != nil {
		t.Fatalf("vouch: %v", err)
	}
	vw, err := WithdrawVouch(device.Pub, member.Pub, member.Priv, testNow+1)
	if err != nil {
		t.Fatalf("withdraw: %v", err)
	}

	// Each object verifies as itself.
	if !VerifyAttestation(att) {
		t.Error("attestation does not self-verify")
	}
	if !VerifyDeviceDelegation(dd) {
		t.Error("device delegation does not self-verify")
	}
	if !VerifySessionDelegation(sd) {
		t.Error("session delegation does not self-verify")
	}
	if !VerifyDeviceRevoke(dr) {
		t.Error("device revoke does not self-verify")
	}
	if !VerifyAgentDelegation(ad) {
		t.Error("agent delegation does not self-verify")
	}
	if !VerifyVouchWithdraw(vw) {
		t.Error("vouch withdrawal does not self-verify")
	}

	// Cross-decoding: marshal each object, decode it as every OTHER type, and
	// require the verification to fail.
	objs := map[string]any{
		"attestation":        att,
		"device_delegation":  dd,
		"session_delegation": sd,
		"device_revoke":      dr,
		"agent_delegation":   ad,
		"vouch_withdraw":     vw,
	}
	for name, obj := range objs {
		blob, err := Marshal(obj)
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}

		if name != "attestation" {
			var o IdentityAttestation
			if Unmarshal(blob, &o) == nil && VerifyAttestation(&o) {
				t.Errorf("%s verified as an attestation", name)
			}
		}
		if name != "device_delegation" {
			var o DeviceDelegation
			if Unmarshal(blob, &o) == nil && VerifyDeviceDelegation(&o) {
				t.Errorf("%s verified as a device delegation", name)
			}
		}
		if name != "session_delegation" {
			var o SessionDelegation
			if Unmarshal(blob, &o) == nil && VerifySessionDelegation(&o) {
				t.Errorf("%s verified as a session delegation", name)
			}
		}
		if name != "device_revoke" {
			var o DeviceRevoke
			if Unmarshal(blob, &o) == nil && VerifyDeviceRevoke(&o) {
				t.Errorf("%s verified as a device revoke", name)
			}
		}
		if name != "agent_delegation" {
			var o AgentDelegation
			if Unmarshal(blob, &o) == nil && VerifyAgentDelegation(&o) {
				t.Errorf("%s verified as an agent delegation", name)
			}
		}
		if name != "vouch_withdraw" {
			var o VouchWithdraw
			if Unmarshal(blob, &o) == nil && VerifyVouchWithdraw(&o) {
				t.Errorf("%s verified as a vouch withdrawal", name)
			}
		}
	}
}

// The tag must be load-bearing, not decorative: an object whose stored type
// disagrees with its Go shape is rejected BEFORE the signature is considered.
func TestTypeTagIsEnforced(t *testing.T) {
	member, _ := GenerateKey()
	device, _ := GenerateKey()

	att, _ := NewSelfAttestation(member, KindHuman, "Sam", nil, testNow)
	if att.Type != TypeAttestation {
		t.Fatalf("Sign did not stamp the tag: %q", att.Type)
	}

	// Relabelled: signature is untouched and still covers the canonical tag, but
	// the object now CLAIMS to be something else.
	mislabelled := *att
	mislabelled.Type = TypeDeviceDelegation
	if VerifyAttestation(&mislabelled) {
		t.Error("an attestation claiming to be a device delegation verified")
	}

	// Tag stripped entirely (e.g. an object from before this change).
	untagged := *att
	untagged.Type = ""
	if VerifyAttestation(&untagged) {
		t.Error("an untagged attestation verified")
	}

	dd, _ := ApprovePairing(mustPairing(t, device.Pub, "x"), member.Pub, member.Priv, testNow, 0)
	if dd.Type != TypeDeviceDelegation {
		t.Fatalf("delegation tag = %q", dd.Type)
	}
	swapped := *dd
	swapped.Type = TypeSessionDelegation
	if VerifyDeviceDelegation(&swapped) {
		t.Error("a delegation relabelled as a session delegation verified")
	}
}

// ObjectType is what a carrier dispatches on, so it must reject anything it
// cannot confidently label rather than guessing.
func TestObjectTypeDispatch(t *testing.T) {
	member, _ := GenerateKey()
	att, _ := NewSelfAttestation(member, KindHuman, "Sam", nil, testNow)

	blob, err := Marshal(att)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ObjectType(blob)
	if err != nil {
		t.Fatalf("ObjectType: %v", err)
	}
	if got != TypeAttestation {
		t.Errorf("ObjectType = %q, want %q", got, TypeAttestation)
	}

	if _, err := ObjectType([]byte{0xff, 0xff}); err == nil {
		t.Error("undecodable bytes produced a type")
	}
	// A well-formed CBOR map with no tag must error, not default to a type.
	untagged, _ := Marshal(map[string]string{"hello": "world"})
	if _, err := ObjectType(untagged); err == nil {
		t.Error("an untagged object produced a type")
	}
}

func TestVerifiersRejectNilAndTampered(t *testing.T) {
	if VerifyAttestation(nil) || VerifyDeviceDelegation(nil) ||
		VerifySessionDelegation(nil) || VerifyDeviceRevoke(nil) {
		t.Fatal("a nil object verified")
	}

	member, _ := GenerateKey()
	att, _ := NewSelfAttestation(member, KindHuman, "Sam", nil, testNow)

	tampered := *att
	tampered.DisplayName = "Admin"
	if VerifyAttestation(&tampered) {
		t.Error("tampered display name verified")
	}

	swapped := *att
	swapped.Kind = KindService
	if VerifyAttestation(&swapped) {
		t.Error("tampered kind verified")
	}

	nosig := *att
	nosig.Sig = nil
	if VerifyAttestation(&nosig) {
		t.Error("unsigned attestation verified")
	}
}

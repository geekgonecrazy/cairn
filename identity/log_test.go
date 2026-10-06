package identity

import (
	"bytes"
	"testing"
)

// selfAttested builds a member with a self-attestation registered in a fresh
// DeviceLog. In the v2 model a member is just a keypair that self-attests; there
// is no household above it. Distinct from identity_test.go's newChain, which
// registers objects against a memResolver.
func selfAttested(t *testing.T) (KeyPair, *DeviceLog) {
	t.Helper()
	member, _ := GenerateKey()
	att, err := NewSelfAttestation(member, KindHuman, "Sam", nil, testNow)
	if err != nil {
		t.Fatalf("self-attest: %v", err)
	}
	log := NewDeviceLog()
	if err := log.AddAttestation(att); err != nil {
		t.Fatalf("add attestation: %v", err)
	}
	return member, log
}

func pairDevice(t *testing.T, log *DeviceLog, member KeyPair, label string) KeyPair {
	t.Helper()
	dev, _ := GenerateKey()
	dd, err := ApprovePairing(mustPairing(t, dev.Pub, label), member.Pub, member.Priv, testNow, 0)
	if err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	if err := log.AddDelegation(dd); err != nil {
		t.Fatalf("add delegation: %v", err)
	}
	return dev
}

func TestRevokeStopsVerification(t *testing.T) {
	member, log := selfAttested(t)
	dev := pairDevice(t, log, member, "laptop")

	if _, err := VerifySender(dev.Pub, log, testNow); err != nil {
		t.Fatalf("paired device does not verify: %v", err)
	}

	dr, err := RevokeDevice(dev.Pub, member.Pub, member.Priv, testNow+1)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if err := log.AddRevoke(dr); err != nil {
		t.Fatalf("add revoke: %v", err)
	}
	if _, err := VerifySender(dev.Pub, log, testNow+2); err == nil {
		t.Fatal("revoked device still verifies")
	}
}

// Revocation must win regardless of the order objects arrive in — a device that
// syncs the revoke before the delegation must reach the same conclusion.
func TestRevokeWinsOutOfOrder(t *testing.T) {
	member, log := selfAttested(t)
	dev, _ := GenerateKey()

	dd, _ := ApprovePairing(mustPairing(t, dev.Pub, "stolen"), member.Pub, member.Priv, testNow, 0)
	dr, _ := RevokeDevice(dev.Pub, member.Pub, member.Priv, testNow+1)

	// Revoke first, delegation second.
	if err := log.AddRevoke(dr); err != nil {
		t.Fatalf("add revoke: %v", err)
	}
	if err := log.AddDelegation(dd); err == nil {
		t.Fatal("delegation for a revoked device was accepted")
	}
	if _, err := VerifySender(dev.Pub, log, testNow+2); err == nil {
		t.Fatal("revoked device verifies when the revoke arrived first")
	}
}

// A member must not be able to revoke another member's device.
func TestCrossMemberRevokeRefused(t *testing.T) {
	member, log := selfAttested(t)
	dev := pairDevice(t, log, member, "sam's laptop")

	attacker, _ := GenerateKey()
	att, _ := NewSelfAttestation(attacker, KindHuman, "Mallory", nil, testNow)
	_ = log.AddAttestation(att)

	dr, _ := RevokeDevice(dev.Pub, attacker.Pub, attacker.Priv, testNow+1)
	if err := log.AddRevoke(dr); err == nil {
		t.Fatal("a different member revoked someone else's device")
	}
	if _, err := VerifySender(dev.Pub, log, testNow+2); err != nil {
		t.Fatalf("device wrongly revoked by another member: %v", err)
	}
}

func TestForgedObjectsRejected(t *testing.T) {
	member, log := selfAttested(t)
	mallory, _ := GenerateKey()
	dev, _ := GenerateKey()

	t.Run("delegation signed by a non-member", func(t *testing.T) {
		dd, _ := ApprovePairing(mustPairing(t, dev.Pub, "x"), member.Pub, mallory.Priv, testNow, 0)
		if err := log.AddDelegation(dd); err == nil {
			t.Fatal("delegation with a mismatched signature was accepted")
		}
	})

	t.Run("attestation not signed by the key it names", func(t *testing.T) {
		victim, _ := GenerateKey()
		att := &IdentityAttestation{
			Pubkey: victim.Pub, Kind: KindHuman, DisplayName: "impostor", IssuedAt: testNow,
		}
		// Signed by Mallory while CLAIMING to be victim's own self-attestation.
		if err := Sign(att, mallory.Priv); err != nil {
			t.Fatal(err)
		}
		if err := log.AddAttestation(att); err == nil {
			t.Fatal("attestation not signed by its own key was accepted")
		}
	})

	t.Run("tampered display name", func(t *testing.T) {
		att, _ := NewSelfAttestation(dev, KindHuman, "Sam", nil, testNow)
		att.DisplayName = "Admin"
		if err := log.AddAttestation(att); err == nil {
			t.Fatal("attestation with a tampered display name was accepted")
		}
	})
}

func TestConflictingKindKeptEarliest(t *testing.T) {
	member, log := selfAttested(t)
	// A second attestation with a different kind is ACCEPTED at insert — the
	// log is an order-independent set, so insert-time rejection would diverge
	// across replicas that learn the same objects in a different order. The
	// rule lives in selection: kind is earliest-issued-wins (CurrentAttestation).
	att, err := NewSelfAttestation(member, KindService, "Sam", nil, testNow+1)
	if err != nil {
		t.Fatalf("self-attest: %v", err)
	}
	if err := log.AddAttestation(att); err != nil {
		t.Fatalf("later kind change refused at insert: %v", err)
	}
	got, ok := log.Attestation(member.Pub)
	if !ok {
		t.Fatal("no attestation selected")
	}
	if got.Kind != KindHuman {
		t.Fatalf("kind = %q, want human (earliest-wins)", got.Kind)
	}
}

func TestDeviceCannotBeRebound(t *testing.T) {
	member, log := selfAttested(t)
	dev := pairDevice(t, log, member, "laptop")

	other, _ := GenerateKey()
	att, _ := NewSelfAttestation(other, KindHuman, "Other", nil, testNow)
	_ = log.AddAttestation(att)

	dd, _ := ApprovePairing(mustPairing(t, dev.Pub, "laptop"), other.Pub, other.Priv, testNow+1, 0)
	if err := log.AddDelegation(dd); err == nil {
		t.Fatal("device was rebound to a different member root")
	}
}

func TestDevicesListsOnlyLiveDelegations(t *testing.T) {
	member, log := selfAttested(t)
	a := pairDevice(t, log, member, "laptop")
	b := pairDevice(t, log, member, "phone")

	if got := len(log.Devices(member.Pub)); got != 2 {
		t.Fatalf("Devices = %d, want 2", got)
	}
	dr, _ := RevokeDevice(a.Pub, member.Pub, member.Priv, testNow+1)
	if err := log.AddRevoke(dr); err != nil {
		t.Fatal(err)
	}
	devices := log.Devices(member.Pub)
	if len(devices) != 1 || !bytes.Equal(devices[0].DevicePub, b.Pub) {
		t.Fatalf("Devices after revoke = %d entries, want only the phone", len(devices))
	}
}

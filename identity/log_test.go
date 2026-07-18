package identity

import (
	"bytes"
	"testing"
)

// bootstrapped builds a real bootstrapped household (mnemonic-derived root)
// with one attested member and a DeviceLog — distinct from identity_test.go's
// newHousehold, which uses ad-hoc keys against a memResolver.
func bootstrapped(t *testing.T) (*Household, KeyPair, *DeviceLog) {
	t.Helper()
	hh, err := Bootstrap()
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	member, _ := GenerateKey()
	att, err := ProvisionMember(hh.Mnemonic, "", member.Pub, KindHuman, "Sam", nil, testNow)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	log := NewDeviceLog()
	if err := log.AddAttestation(att); err != nil {
		t.Fatalf("add attestation: %v", err)
	}
	return hh, member, log
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
	hh, member, log := bootstrapped(t)
	dev := pairDevice(t, log, member, "laptop")

	if _, err := VerifySender(dev.Pub, log, [][]byte{hh.RootPub}, testNow); err != nil {
		t.Fatalf("paired device does not verify: %v", err)
	}

	dr, err := RevokeDevice(dev.Pub, member.Pub, member.Priv, testNow+1)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if err := log.AddRevoke(dr); err != nil {
		t.Fatalf("add revoke: %v", err)
	}
	if _, err := VerifySender(dev.Pub, log, [][]byte{hh.RootPub}, testNow+2); err == nil {
		t.Fatal("revoked device still verifies")
	}
}

// Revocation must win regardless of the order objects arrive in — a device that
// syncs the revoke before the delegation must reach the same conclusion.
func TestRevokeWinsOutOfOrder(t *testing.T) {
	hh, member, log := bootstrapped(t)
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
	if _, err := VerifySender(dev.Pub, log, [][]byte{hh.RootPub}, testNow+2); err == nil {
		t.Fatal("revoked device verifies when the revoke arrived first")
	}
}

// A member must not be able to revoke another member's device.
func TestCrossMemberRevokeRefused(t *testing.T) {
	hh, member, log := bootstrapped(t)
	dev := pairDevice(t, log, member, "sam's laptop")

	attacker, _ := GenerateKey()
	att, _ := ProvisionMember(hh.Mnemonic, "", attacker.Pub, KindHuman, "Mallory", nil, testNow)
	_ = log.AddAttestation(att)

	dr, _ := RevokeDevice(dev.Pub, attacker.Pub, attacker.Priv, testNow+1)
	if err := log.AddRevoke(dr); err == nil {
		t.Fatal("a different member revoked someone else's device")
	}
	if _, err := VerifySender(dev.Pub, log, [][]byte{hh.RootPub}, testNow+2); err != nil {
		t.Fatalf("device wrongly revoked by another member: %v", err)
	}
}

func TestForgedObjectsRejected(t *testing.T) {
	hh, member, log := bootstrapped(t)
	mallory, _ := GenerateKey()
	dev, _ := GenerateKey()

	t.Run("delegation signed by a non-member", func(t *testing.T) {
		dd, _ := ApprovePairing(mustPairing(t, dev.Pub, "x"), member.Pub, mallory.Priv, testNow, 0)
		if err := log.AddDelegation(dd); err == nil {
			t.Fatal("delegation with a mismatched signature was accepted")
		}
	})

	t.Run("attestation not signed by the household root", func(t *testing.T) {
		victim, _ := GenerateKey()
		att := &IdentityAttestation{
			Pubkey: victim.Pub, Kind: KindHuman,
			Origin: hh.RootPub, DisplayName: "impostor", IssuedAt: testNow,
		}
		// Signed by Mallory while CLAIMING the real household as origin.
		if err := Sign(att, mallory.Priv); err != nil {
			t.Fatal(err)
		}
		if err := log.AddAttestation(att); err == nil {
			t.Fatal("attestation forged against a real origin was accepted")
		}
	})

	t.Run("tampered display name", func(t *testing.T) {
		att, _ := ProvisionMember(hh.Mnemonic, "", dev.Pub, KindHuman, "Sam", nil, testNow)
		att.DisplayName = "Admin"
		if err := log.AddAttestation(att); err == nil {
			t.Fatal("attestation with a tampered display name was accepted")
		}
	})
}

func TestConflictingAttestationRefused(t *testing.T) {
	hh, member, log := bootstrapped(t)
	// Same member, same household, but a different immutable kind.
	att, err := ProvisionMember(hh.Mnemonic, "", member.Pub, KindService, "Sam", nil, testNow+1)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if err := log.AddAttestation(att); err == nil {
		t.Fatal("conflicting kind was accepted for an existing member")
	}
}

func TestDeviceCannotBeRebound(t *testing.T) {
	hh, member, log := bootstrapped(t)
	dev := pairDevice(t, log, member, "laptop")

	other, _ := GenerateKey()
	att, _ := ProvisionMember(hh.Mnemonic, "", other.Pub, KindHuman, "Other", nil, testNow)
	_ = log.AddAttestation(att)

	dd, _ := ApprovePairing(mustPairing(t, dev.Pub, "laptop"), other.Pub, other.Priv, testNow+1, 0)
	if err := log.AddDelegation(dd); err == nil {
		t.Fatal("device was rebound to a different member root")
	}
	_ = hh
}

func TestUntrustedHouseholdRejected(t *testing.T) {
	_, member, log := bootstrapped(t)
	dev := pairDevice(t, log, member, "laptop")

	stranger, _ := Bootstrap()
	if _, err := VerifySender(dev.Pub, log, [][]byte{stranger.RootPub}, testNow); err == nil {
		t.Fatal("device verified against a household that never attested it")
	}
}

func TestDevicesListsOnlyLiveDelegations(t *testing.T) {
	_, member, log := bootstrapped(t)
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

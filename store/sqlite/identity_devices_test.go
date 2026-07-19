package sqlite

import (
	"encoding/hex"
	"testing"

	"github.com/geekgonecrazy/cairn/identity"
)

// DevicesUnder is the wrap-target lookup: room keys seal to DEVICE keys, so
// admitting a member means sealing to every device in their tree. Getting the
// cascade wrong here is a confidentiality bug in both directions — miss a device
// and its owner silently loses the room; include a revoked one and a device that
// is supposed to be cut off keeps reading.
func TestDevicesUnder_WholeTreeMinusRevokedSubtree(t *testing.T) {
	s := newTestStore(t)
	member, _ := identity.GenerateKey()
	laptop, _ := identity.GenerateKey()
	phone, _ := identity.GenerateKey()
	tablet, _ := identity.GenerateKey()
	desktop, _ := identity.GenerateKey()

	// member ──> laptop ──> phone ──> tablet
	//        └─> desktop
	link := func(child, parent identity.KeyPair) {
		dd := &identity.DeviceDelegation{
			DevicePub: child.Pub, ParentPub: parent.Pub, IssuedAt: 1,
		}
		if err := identity.Sign(dd, parent.Priv); err != nil {
			t.Fatal(err)
		}
		if err := s.PutDeviceDelegation(dd); err != nil {
			t.Fatal(err)
		}
	}
	link(laptop, member)
	link(desktop, member)
	link(phone, laptop)
	link(tablet, phone)

	has := func(set [][]byte, want identity.KeyPair) bool {
		for _, p := range set {
			if hex.EncodeToString(p) == hex.EncodeToString(want.Pub) {
				return true
			}
		}
		return false
	}

	got, err := s.DevicesUnder(member.Pub)
	if err != nil {
		t.Fatal(err)
	}
	// Depth must not matter: a tablet paired from a phone belongs to the member
	// just as much as the laptop the member root signed directly.
	for _, want := range []identity.KeyPair{laptop, desktop, phone, tablet} {
		if !has(got, want) {
			t.Fatalf("device missing from the member's tree: %x", want.Pub[:6])
		}
	}
	if len(got) != 4 {
		t.Fatalf("want 4 devices, got %d", len(got))
	}

	// Revoke the phone. The tablet was paired FROM it, so both must drop out —
	// the tablet without anyone naming it.
	dr, err := identity.RevokeDevice(phone.Pub, laptop.Pub, laptop.Priv, 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PutDeviceRevoke(dr); err != nil {
		t.Fatal(err)
	}

	got, err = s.DevicesUnder(member.Pub)
	if err != nil {
		t.Fatal(err)
	}
	if has(got, phone) {
		t.Fatal("revoked device still in the wrap set — it would keep reading new epochs")
	}
	if has(got, tablet) {
		t.Fatal("device paired from a REVOKED device is still in the wrap set: the cascade " +
			"did not apply, so a thief who paired their own device from a stolen one keeps access")
	}
	if !has(got, laptop) || !has(got, desktop) {
		t.Fatal("revoking a device below the member removed unrelated devices")
	}
	if len(got) != 2 {
		t.Fatalf("want 2 surviving devices, got %d", len(got))
	}
}

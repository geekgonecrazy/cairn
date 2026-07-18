package core

import (
	"errors"
	"testing"

	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// testHousehold is a household root + its mnemonic — the apex that attests
// members. A household can mint any number of attested members.
type testHousehold struct {
	mnemonic string
	root     identity.KeyPair
}

func newHousehold(t *testing.T) *testHousehold {
	t.Helper()
	mnemonic, err := identity.NewMnemonic()
	if err != nil {
		t.Fatal(err)
	}
	root, err := identity.HouseholdRootFromMnemonic(mnemonic, "")
	if err != nil {
		t.Fatal(err)
	}
	return &testHousehold{mnemonic: mnemonic, root: root}
}

// testMember is a full sender chain under a household: an attested member root
// and a delegated device key, plus the identity-log objects a carrier needs to
// verify events the device signs.
type testMember struct {
	hh     *testHousehold
	member identity.KeyPair
	device identity.KeyPair
	att    *identity.IdentityAttestation
	dd     *identity.DeviceDelegation
}

// member provisions a fresh attested member (with one device) under this household.
func (h *testHousehold) member(t *testing.T, name string) *testMember {
	t.Helper()
	member, err := identity.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	device, err := identity.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	att, err := identity.ProvisionMember(h.mnemonic, "", member.Pub, identity.KindHuman, name, nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	req, err := identity.NewPairingRequest(device.Pub, "device")
	if err != nil {
		t.Fatal(err)
	}
	dd, err := identity.ApprovePairing(req, member.Pub, member.Priv, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	return &testMember{hh: h, member: member, device: device, att: att, dd: dd}
}

// install stores this member's identity-log objects, the way PutIdentityObject
// would after verifying them.
func (m *testMember) install(t *testing.T) {
	t.Helper()
	if err := st.PutAttestation(m.att); err != nil {
		t.Fatal(err)
	}
	if err := st.PutDeviceDelegation(m.dd); err != nil {
		t.Fatal(err)
	}
}

// chat builds a signed chat event from this member's device key.
func (m *testMember) chat(t *testing.T, ts int64) *cairnv1.Event {
	t.Helper()
	ev, err := event.Build(m.device.Pub, m.device.Priv, []byte("room"), ts, nil, cairnv1.EventType_CHAT, []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	return ev
}

// TestChainGate walks the full default-deny lifecycle: refuse before founding,
// adopt the household root at founding, then accept the household's own sender,
// reject a revoked device, and reject a different household.
func TestChainGate(t *testing.T) {
	setTestStore(t) // allowAdoption = true, no roots yet

	hh := newHousehold(t)
	alice := hh.member(t, "Alice")
	alice.install(t)

	// 1. Awaiting founding: no root adopted yet → refuse, recoverably.
	if err := SubmitEvent(alice.chat(t, 10)); !errors.Is(err, ErrAwaitingFounding) {
		t.Fatalf("pre-founding submit should be ErrAwaitingFounding, got %v", err)
	}

	// 2. Founding: adopting the household root (as PutIdentityObject would) opens
	//    the gate for this household.
	if err := MaybeAdoptRoot(alice.att.Origin); err != nil {
		t.Fatal(err)
	}
	if err := SubmitEvent(alice.chat(t, 11)); err != nil {
		t.Fatalf("after founding, the household's own sender should verify, got %v", err)
	}

	// 3. Revocation is now ENFORCED, not advisory: a revoked device is refused.
	rev, err := identity.RevokeDevice(alice.device.Pub, alice.member.Pub, alice.member.Priv, 12)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.PutDeviceRevoke(rev); err != nil {
		t.Fatal(err)
	}
	err = SubmitEvent(alice.chat(t, 13))
	if !errors.Is(err, identity.ErrRevoked) {
		t.Fatalf("a revoked device should be rejected with ErrRevoked, got %v", err)
	}

	// 4. A different household never chains to the adopted root.
	mallory := newHousehold(t).member(t, "Mallory")
	mallory.install(t)
	err = SubmitEvent(mallory.chat(t, 14))
	if !errors.Is(err, identity.ErrUntrustedRoot) {
		t.Fatalf("a foreign household should be rejected with ErrUntrustedRoot, got %v", err)
	}
}

// TestChainGateUnknownLink: a sender whose identity objects the carrier does not
// yet hold is refused recoverably (ErrUnknownObject), so the client can push them
// and retry — distinct from the terminal rejections above.
func TestChainGateUnknownLink(t *testing.T) {
	setTestStore(t)
	hh := newHousehold(t)
	alice := hh.member(t, "Alice")
	// Adopt the root but do NOT install the device delegation / attestation.
	if err := MaybeAdoptRoot(alice.att.Origin); err != nil {
		t.Fatal(err)
	}
	err := SubmitEvent(alice.chat(t, 10))
	if !errors.Is(err, identity.ErrUnknownObject) {
		t.Fatalf("a sender with no known chain should be ErrUnknownObject, got %v", err)
	}
}

// TestConfiguredRootsDisableAdoption: when the operator pins roots, the founding
// window never opens — a household the carrier was not told about is refused even
// though it is the first one seen.
func TestConfiguredRootsDisableAdoption(t *testing.T) {
	setTestStore(t)
	stranger := newHousehold(t).member(t, "Stranger")
	stranger.install(t)

	// Pin an unrelated root; adoption is off.
	pinned, _ := identity.GenerateKey()
	configuredRoots = [][]byte{pinned.Pub}
	allowAdoption = false

	// Storing the stranger's attestation must NOT adopt it.
	if err := MaybeAdoptRoot(stranger.att.Origin); err != nil {
		t.Fatal(err)
	}
	if err := SubmitEvent(stranger.chat(t, 10)); !errors.Is(err, identity.ErrUntrustedRoot) {
		t.Fatalf("a pinned carrier must not adopt a stranger; want ErrUntrustedRoot, got %v", err)
	}
}

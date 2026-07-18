package identity

import (
	"errors"
	"testing"
)

// memResolver is an in-memory Resolver for tests, keyed the way the store will
// index the identity log.
type memResolver struct {
	sessions map[string]*SessionDelegation // by session_pub
	devices  map[string]*DeviceDelegation  // by device_pub
	revoked  map[string]bool               // by device_pub
	atts     map[string]*IdentityAttestation
}

func newMemResolver() *memResolver {
	return &memResolver{
		sessions: map[string]*SessionDelegation{},
		devices:  map[string]*DeviceDelegation{},
		revoked:  map[string]bool{},
		atts:     map[string]*IdentityAttestation{},
	}
}

func (m *memResolver) SessionDelegation(p []byte) (*SessionDelegation, bool) {
	d, ok := m.sessions[string(p)]
	return d, ok
}
func (m *memResolver) DeviceDelegation(p []byte) (*DeviceDelegation, bool) {
	d, ok := m.devices[string(p)]
	return d, ok
}
func (m *memResolver) DeviceRevoked(p []byte) bool { return m.revoked[string(p)] }
func (m *memResolver) Attestation(p []byte) (*IdentityAttestation, bool) {
	a, ok := m.atts[string(p)]
	return a, ok
}

// household builds a full household → member → device → session chain and
// registers every object in the resolver. Returns the keys for the test to use.
type household struct {
	root, member, device, session KeyPair
	res                           *memResolver
}

func newHousehold(t *testing.T) *household {
	t.Helper()
	root, err := GenerateKey()
	must(t, err)
	member, err := GenerateKey()
	must(t, err)
	device, err := GenerateKey()
	must(t, err)
	session, err := GenerateKey()
	must(t, err)

	res := newMemResolver()

	att := &IdentityAttestation{
		Pubkey: member.Pub, Kind: KindHuman, Origin: root.Pub,
		DisplayName: "Ada", IssuedAt: 1000,
	}
	if err := Sign(att, root.Priv); err != nil {
		t.Fatal(err)
	}
	res.atts[string(member.Pub)] = att

	dd := &DeviceDelegation{DevicePub: device.Pub, MemberPub: member.Pub, IssuedAt: 1000}
	if err := Sign(dd, member.Priv); err != nil {
		t.Fatal(err)
	}
	res.devices[string(device.Pub)] = dd

	sd := &SessionDelegation{SessionPub: session.Pub, DevicePub: device.Pub, Scope: "chat", ExpiresAt: 9_000_000}
	if err := Sign(sd, device.Priv); err != nil {
		t.Fatal(err)
	}
	res.sessions[string(session.Pub)] = sd

	return &household{root: root, member: member, device: device, session: session, res: res}
}

func TestVerifySender_SessionChain(t *testing.T) {
	h := newHousehold(t)
	got, err := VerifySender(h.session.Pub, h.res, [][]byte{h.root.Pub}, 2000)
	if err != nil {
		t.Fatalf("verify session chain: %v", err)
	}
	if got.Kind != KindHuman || got.DisplayName != "Ada" {
		t.Fatalf("resolved wrong identity: %+v", got)
	}
	if string(got.Origin) != string(h.root.Pub) {
		t.Fatalf("origin mismatch")
	}
}

func TestVerifySender_DeviceDirect(t *testing.T) {
	// A device key that signs without a session tier (native/agent) still verifies.
	h := newHousehold(t)
	if _, err := VerifySender(h.device.Pub, h.res, [][]byte{h.root.Pub}, 2000); err != nil {
		t.Fatalf("verify device-direct: %v", err)
	}
}

func TestVerifySender_UntrustedRoot(t *testing.T) {
	h := newHousehold(t)
	other, _ := GenerateKey()
	_, err := VerifySender(h.session.Pub, h.res, [][]byte{other.Pub}, 2000)
	if !errors.Is(err, ErrUntrustedRoot) {
		t.Fatalf("want ErrUntrustedRoot, got %v", err)
	}
}

func TestVerifySender_Expired(t *testing.T) {
	h := newHousehold(t)
	_, err := VerifySender(h.session.Pub, h.res, [][]byte{h.root.Pub}, 10_000_000)
	if !errors.Is(err, ErrExpired) {
		t.Fatalf("want ErrExpired, got %v", err)
	}
}

func TestVerifySender_Revoked(t *testing.T) {
	h := newHousehold(t)
	h.res.revoked[string(h.device.Pub)] = true
	_, err := VerifySender(h.session.Pub, h.res, [][]byte{h.root.Pub}, 2000)
	if !errors.Is(err, ErrRevoked) {
		t.Fatalf("want ErrRevoked, got %v", err)
	}
}

func TestVerifySender_TamperedAttestation(t *testing.T) {
	h := newHousehold(t)
	// Flip the display name after signing → signature must fail.
	h.res.atts[string(h.member.Pub)].DisplayName = "Mallory"
	_, err := VerifySender(h.session.Pub, h.res, [][]byte{h.root.Pub}, 2000)
	if !errors.Is(err, ErrBadSignature) {
		t.Fatalf("want ErrBadSignature, got %v", err)
	}
}

func TestVerifySender_MissingLink(t *testing.T) {
	h := newHousehold(t)
	delete(h.res.devices, string(h.device.Pub))
	_, err := VerifySender(h.session.Pub, h.res, [][]byte{h.root.Pub}, 2000)
	if !errors.Is(err, ErrUnknownObject) {
		t.Fatalf("want ErrUnknownObject, got %v", err)
	}
}

func TestHash_Deterministic(t *testing.T) {
	att := &IdentityAttestation{Pubkey: []byte{1, 2, 3}, Kind: KindAgent, Origin: []byte{9}, IssuedAt: 42}
	h1, err := Hash(att)
	must(t, err)
	h2, err := Hash(att)
	must(t, err)
	if h1 != h2 {
		t.Fatal("hash not deterministic")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

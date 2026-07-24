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
	revoked  map[string]*DeviceRevoke      // by device_pub
	atts     map[string]*IdentityAttestation
}

func newMemResolver() *memResolver {
	return &memResolver{
		sessions: map[string]*SessionDelegation{},
		devices:  map[string]*DeviceDelegation{},
		revoked:  map[string]*DeviceRevoke{},
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
func (m *memResolver) DeviceRevokeFor(p []byte) (*DeviceRevoke, bool) {
	d, ok := m.revoked[string(p)]
	return d, ok
}
func (m *memResolver) Attestation(p []byte) (*IdentityAttestation, bool) {
	a, ok := m.atts[string(p)]
	return a, ok
}

// chain builds a full member → device → session chain (v2: no household root)
// and registers every object in the resolver. Returns the keys for the test.
type chain struct {
	member, device, session KeyPair
	res                     *memResolver
}

func newChain(t *testing.T) *chain {
	t.Helper()
	member, err := GenerateKey()
	must(t, err)
	device, err := GenerateKey()
	must(t, err)
	session, err := GenerateKey()
	must(t, err)

	res := newMemResolver()

	att, err := NewSelfAttestation(member, KindHuman, "Ada", nil, 1000)
	must(t, err)
	res.atts[string(member.Pub)] = att

	dd := &DeviceDelegation{DevicePub: device.Pub, ParentPub: member.Pub, IssuedAt: 1000}
	must(t, Sign(dd, member.Priv))
	res.devices[string(device.Pub)] = dd

	sd := &SessionDelegation{SessionPub: session.Pub, DevicePub: device.Pub, Scope: "chat", ExpiresAt: 9_000_000}
	must(t, Sign(sd, device.Priv))
	res.sessions[string(session.Pub)] = sd

	return &chain{member: member, device: device, session: session, res: res}
}

func TestVerifySender_SessionChain(t *testing.T) {
	h := newChain(t)
	got, err := VerifySender(h.session.Pub, h.res, 2000)
	if err != nil {
		t.Fatalf("verify session chain: %v", err)
	}
	if got.Kind != KindHuman || got.DisplayName != "Ada" {
		t.Fatalf("resolved wrong identity: %+v", got)
	}
	if string(got.MemberPub) != string(h.member.Pub) {
		t.Fatalf("member mismatch")
	}
}

func TestVerifySender_DeviceDirect(t *testing.T) {
	// A device key that signs without a session tier (native/agent) still verifies.
	h := newChain(t)
	if _, err := VerifySender(h.device.Pub, h.res, 2000); err != nil {
		t.Fatalf("verify device-direct: %v", err)
	}
}

func TestVerifySender_Expired(t *testing.T) {
	h := newChain(t)
	_, err := VerifySender(h.session.Pub, h.res, 10_000_000)
	if !errors.Is(err, ErrExpired) {
		t.Fatalf("want ErrExpired, got %v", err)
	}
}

// fileRevoke registers a DeviceRevoke for h's device signed by `signer`, the way
// a permissive identity log would: no check that the signer owns the device.
func fileRevoke(t *testing.T, h *chain, signer KeyPair) {
	t.Helper()
	dr, err := RevokeDevice(h.device.Pub, signer.Pub, signer.Priv, 1500)
	must(t, err)
	h.res.revoked[string(h.device.Pub)] = dr
}

func TestVerifySender_Revoked(t *testing.T) {
	h := newChain(t)
	fileRevoke(t, h, h.member) // the member root that actually holds the device
	_, err := VerifySender(h.session.Pub, h.res, 2000)
	if !errors.Is(err, ErrRevoked) {
		t.Fatalf("want ErrRevoked, got %v", err)
	}
}

// A revoke is an assertion by a member root about ITS OWN device. The identity
// log is an open set that anyone can file well-signed objects into, so if a
// revoke bound without an authority check, any keypair could permanently lock
// out any device — and permanently, since a revoked key can never be re-paired.
func TestVerifySender_RevokeByAnotherMemberIsIgnored(t *testing.T) {
	h := newChain(t)
	attacker, err := GenerateKey()
	must(t, err)
	fileRevoke(t, h, attacker)

	if _, err := VerifySender(h.session.Pub, h.res, 2000); err != nil {
		t.Fatalf("a revoke signed by a non-owner must not bind, got %v", err)
	}
}

// The signature still has to check out: a real revoke tampered with in transit
// (or forged wholesale under the owner's member key) must not bind either.
func TestVerifySender_ForgedRevokeIsIgnored(t *testing.T) {
	h := newChain(t)
	fileRevoke(t, h, h.member)
	h.res.revoked[string(h.device.Pub)].Sig[0] ^= 0xff

	if _, err := VerifySender(h.session.Pub, h.res, 2000); err != nil {
		t.Fatalf("a revoke with a broken signature must not bind, got %v", err)
	}
}

// --- delegation tree ------------------------------------------------------
//
// Devices pair devices: the member root signs only the FIRST device, and every
// device after that is admitted by an existing one. These pin the properties
// that make that safe — see docs/adrs/0007-device-delegation-tree-revocation.md.

// pair admits a fresh device under `parent` and registers the delegation,
// returning the new device's keys. Mirrors what a trusted device does when it
// scans a new one's pairing QR.
func pair(t *testing.T, h *chain, parent KeyPair) KeyPair {
	t.Helper()
	child, err := GenerateKey()
	must(t, err)
	req, err := NewPairingRequest(child.Pub, "paired device")
	must(t, err)
	dd, err := ApprovePairing(req, parent.Pub, parent.Priv, 1000, 0)
	must(t, err)
	h.res.devices[string(child.Pub)] = dd
	return child
}

func TestVerifySender_DeviceDelegatedByDevice(t *testing.T) {
	h := newChain(t)
	phone := pair(t, h, h.device) // phone paired from the laptop
	tablet := pair(t, h, phone)   // tablet paired from the phone, laptop at home

	got, err := VerifySender(tablet.Pub, h.res, 2000)
	if err != nil {
		t.Fatalf("verify tablet → phone → laptop → member: %v", err)
	}
	// The identity resolved is the MEMBER's, however deep the device sits.
	if got.DisplayName != "Ada" || string(got.MemberPub) != string(h.member.Pub) {
		t.Fatalf("deep device resolved to the wrong identity: %+v", got)
	}
}

// The cascade: revoking a device must invalidate everything paired FROM it,
// without anyone naming the descendants. A thief who paired their own device
// from a stolen phone otherwise keeps access after the phone is revoked.
func TestVerifySender_RevocationCascadesToDescendants(t *testing.T) {
	h := newChain(t)
	phone := pair(t, h, h.device)
	tablet := pair(t, h, phone)

	// The laptop revokes the phone — and says nothing at all about the tablet.
	dr, err := RevokeDevice(phone.Pub, h.device.Pub, h.device.Priv, 1500)
	must(t, err)
	h.res.revoked[string(phone.Pub)] = dr

	if _, err := VerifySender(phone.Pub, h.res, 2000); !errors.Is(err, ErrRevoked) {
		t.Fatalf("revoked phone: want ErrRevoked, got %v", err)
	}
	if _, err := VerifySender(tablet.Pub, h.res, 2000); !errors.Is(err, ErrRevoked) {
		t.Fatalf("tablet paired from the revoked phone must fall with it, got %v", err)
	}
	// The laptop above the revoked device is untouched.
	if _, err := VerifySender(h.device.Pub, h.res, 2000); err != nil {
		t.Fatalf("laptop must be unaffected by revoking a device below it: %v", err)
	}
}

// Ancestors only. A stolen phone must not be able to revoke the laptop above it.
func TestVerifySender_DeviceCannotRevokeItsAncestor(t *testing.T) {
	h := newChain(t)
	phone := pair(t, h, h.device)

	dr, err := RevokeDevice(h.device.Pub, phone.Pub, phone.Priv, 1500)
	must(t, err)
	h.res.revoked[string(h.device.Pub)] = dr

	if _, err := VerifySender(h.device.Pub, h.res, 2000); err != nil {
		t.Fatalf("a child must not be able to revoke its parent, got %v", err)
	}
}

// Nor a sibling: two devices paired from the same laptop are peers.
func TestVerifySender_SiblingCannotRevokeSibling(t *testing.T) {
	h := newChain(t)
	phone := pair(t, h, h.device)
	tablet := pair(t, h, h.device)

	dr, err := RevokeDevice(tablet.Pub, phone.Pub, phone.Priv, 1500)
	must(t, err)
	h.res.revoked[string(tablet.Pub)] = dr

	if _, err := VerifySender(tablet.Pub, h.res, 2000); err != nil {
		t.Fatalf("a sibling must not be able to revoke a sibling, got %v", err)
	}
}

// The member root sits above everything and may revoke at any depth — the
// recovery path when the device that did the pairing is itself lost.
func TestVerifySender_MemberRootRevokesAtAnyDepth(t *testing.T) {
	h := newChain(t)
	phone := pair(t, h, h.device)
	tablet := pair(t, h, phone)

	dr, err := RevokeDevice(tablet.Pub, h.member.Pub, h.member.Priv, 1500)
	must(t, err)
	h.res.revoked[string(tablet.Pub)] = dr

	if _, err := VerifySender(tablet.Pub, h.res, 2000); !errors.Is(err, ErrRevoked) {
		t.Fatalf("the member root must be able to revoke any device, got %v", err)
	}
}

// An unbounded walk would be a denial of service on every verifier, since the
// chain is attacker-supplied data.
func TestVerifySender_DepthLimited(t *testing.T) {
	h := newChain(t)
	cur := h.device
	for range MaxChainDepth + 2 {
		cur = pair(t, h, cur)
	}
	if _, err := VerifySender(cur.Pub, h.res, 2000); !errors.Is(err, ErrChainTooDeep) {
		t.Fatalf("want ErrChainTooDeep, got %v", err)
	}
}

// A cycle is reachable only via a log that accepted two parents for one device,
// but the walk runs over whatever a stranger managed to store, so it must
// terminate rather than trusting the log to be well-formed.
func TestVerifySender_CycleDetected(t *testing.T) {
	h := newChain(t)
	a, err := GenerateKey()
	must(t, err)
	b, err := GenerateKey()
	must(t, err)

	link := func(child, parent KeyPair) {
		dd := &DeviceDelegation{DevicePub: child.Pub, ParentPub: parent.Pub, IssuedAt: 1000}
		must(t, Sign(dd, parent.Priv))
		h.res.devices[string(child.Pub)] = dd
	}
	link(a, b)
	link(b, a)

	if _, err := VerifySender(a.Pub, h.res, 2000); !errors.Is(err, ErrChainCycle) {
		t.Fatalf("want ErrChainCycle, got %v", err)
	}
}

func TestVerifySender_TamperedAttestation(t *testing.T) {
	h := newChain(t)
	// Flip the display name after signing → self-signature must fail.
	h.res.atts[string(h.member.Pub)].DisplayName = "Mallory"
	_, err := VerifySender(h.session.Pub, h.res, 2000)
	if !errors.Is(err, ErrBadSignature) {
		t.Fatalf("want ErrBadSignature, got %v", err)
	}
}

func TestVerifySender_MissingLink(t *testing.T) {
	h := newChain(t)
	delete(h.res.devices, string(h.device.Pub))
	_, err := VerifySender(h.session.Pub, h.res, 2000)
	if !errors.Is(err, ErrUnknownObject) {
		t.Fatalf("want ErrUnknownObject, got %v", err)
	}
}

func TestHash_Deterministic(t *testing.T) {
	att := &IdentityAttestation{Pubkey: []byte{1, 2, 3}, Kind: KindAgent, IssuedAt: 42}
	h1, err := Hash(att)
	must(t, err)
	h2, err := Hash(att)
	must(t, err)
	if h1 != h2 {
		t.Fatal("hash not deterministic")
	}
}

// testNow is a fixed unix-ms timestamp shared by the identity tests.
const testNow int64 = 1_700_000_000_000

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// mustPairing builds a PairingRequest or fails the test.
func mustPairing(t *testing.T, pub PubKey, label string) *PairingRequest {
	t.Helper()
	req, err := NewPairingRequest(pub, label)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

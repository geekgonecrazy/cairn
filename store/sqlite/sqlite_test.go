package sqlite

import (
	"path/filepath"
	"testing"

	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CheckDb(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func mkEvent(t *testing.T, kp identity.KeyPair, room string, ts int64, parents [][]byte, body string) *cairnv1.Event {
	t.Helper()
	ev, err := event.Build(kp.Pub, kp.Priv, []byte(room), ts, parents, cairnv1.EventType_CHAT, []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return ev
}

func headSet(t *testing.T, s *Store, room string) map[string]bool {
	t.Helper()
	heads, err := s.Heads([]byte(room))
	if err != nil {
		t.Fatal(err)
	}
	set := map[string]bool{}
	for _, h := range heads {
		set[string(h)] = true
	}
	return set
}

func TestPutEvent_Idempotent(t *testing.T) {
	s := newTestStore(t)
	kp, _ := identity.GenerateKey()
	ev := mkEvent(t, kp, "r", 1, nil, "hi")

	stored, err := s.PutEvent(ev)
	if err != nil || !stored {
		t.Fatalf("first put: stored=%v err=%v", stored, err)
	}
	stored, err = s.PutEvent(ev)
	if err != nil || stored {
		t.Fatalf("second put should dedup: stored=%v err=%v", stored, err)
	}
}

func TestHeads_LinearAndFork(t *testing.T) {
	s := newTestStore(t)
	kp, _ := identity.GenerateKey()

	root := mkEvent(t, kp, "r", 1, nil, "root")
	s.PutEvent(root)
	if h := headSet(t, s, "r"); !h[string(root.EventId)] || len(h) != 1 {
		t.Fatalf("root should be the sole head")
	}

	child := mkEvent(t, kp, "r", 2, [][]byte{root.EventId}, "child")
	s.PutEvent(child)
	if h := headSet(t, s, "r"); !h[string(child.EventId)] || h[string(root.EventId)] || len(h) != 1 {
		t.Fatalf("child should replace root as sole head, got %v", h)
	}

	// Fork: two concurrent children of child.
	a := mkEvent(t, kp, "r", 3, [][]byte{child.EventId}, "A")
	b := mkEvent(t, kp, "r", 4, [][]byte{child.EventId}, "B")
	s.PutEvent(a)
	s.PutEvent(b)
	h := headSet(t, s, "r")
	if len(h) != 2 || !h[string(a.EventId)] || !h[string(b.EventId)] {
		t.Fatalf("fork should yield 2 heads, got %v", h)
	}

	// Merge: an event citing both a and b collapses back to one head.
	merge := mkEvent(t, kp, "r", 5, [][]byte{a.EventId, b.EventId}, "merge")
	s.PutEvent(merge)
	h = headSet(t, s, "r")
	if len(h) != 1 || !h[string(merge.EventId)] {
		t.Fatalf("merge should collapse to 1 head, got %v", h)
	}
}

func TestPutEvent_OutOfOrder(t *testing.T) {
	// A child arriving before its parent must NOT make the child a head, and the
	// later-arriving parent must NOT become a head either.
	s := newTestStore(t)
	kp, _ := identity.GenerateKey()
	parent := mkEvent(t, kp, "r", 1, nil, "parent")
	child := mkEvent(t, kp, "r", 2, [][]byte{parent.EventId}, "child")

	s.PutEvent(child) // parent not yet known
	s.PutEvent(parent)

	h := headSet(t, s, "r")
	if len(h) != 1 || !h[string(child.EventId)] {
		t.Fatalf("after out-of-order delivery, child should be sole head, got %v", h)
	}
}

func TestMissing_SyncDiff(t *testing.T) {
	s := newTestStore(t)
	kp, _ := identity.GenerateKey()
	e1 := mkEvent(t, kp, "r", 1, nil, "1")
	e2 := mkEvent(t, kp, "r", 2, [][]byte{e1.EventId}, "2")
	e3 := mkEvent(t, kp, "r", 3, [][]byte{e2.EventId}, "3")
	for _, e := range []*cairnv1.Event{e1, e2, e3} {
		s.PutEvent(e)
	}

	// Peer already has up to e1 → should be sent e2, e3.
	missing, err := s.Missing([]byte("r"), [][]byte{e1.EventId})
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 2 {
		t.Fatalf("want 2 missing, got %d", len(missing))
	}
	// Oldest-first: e2 before e3.
	if string(missing[0].EventId) != string(e2.EventId) {
		t.Fatalf("missing not oldest-first")
	}

	// Peer with the current head lacks nothing.
	missing, _ = s.Missing([]byte("r"), [][]byte{e3.EventId})
	if len(missing) != 0 {
		t.Fatalf("caught-up peer should lack nothing, got %d", len(missing))
	}
}

func TestIdentityLog_ResolverRoundTrip(t *testing.T) {
	s := newTestStore(t)
	root, _ := identity.GenerateKey()
	member, _ := identity.GenerateKey()
	device, _ := identity.GenerateKey()

	att := &identity.IdentityAttestation{Pubkey: member.Pub, Kind: identity.KindHuman, Origin: root.Pub, DisplayName: "Ada", IssuedAt: 1}
	identity.Sign(att, root.Priv)
	dd := &identity.DeviceDelegation{DevicePub: device.Pub, MemberPub: member.Pub, IssuedAt: 1}
	identity.Sign(dd, member.Priv)

	if err := s.PutAttestation(att); err != nil {
		t.Fatal(err)
	}
	if err := s.PutDeviceDelegation(dd); err != nil {
		t.Fatal(err)
	}

	// Store resolves the device key back to a trusted household root.
	got, err := identity.VerifySender(device.Pub, s, [][]byte{root.Pub}, 100)
	if err != nil {
		t.Fatalf("chain verify via store resolver: %v", err)
	}
	if got.DisplayName != "Ada" {
		t.Fatalf("resolved wrong identity: %+v", got)
	}

	// GetIdentityObject by hash returns the stored CBOR.
	h, _ := identity.Hash(att)
	blob, err := s.GetIdentityObject(h[:])
	if err != nil || blob == nil {
		t.Fatalf("GetIdentityObject: blob=%v err=%v", blob, err)
	}
}

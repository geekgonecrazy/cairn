package event

import (
	"errors"
	"testing"

	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

func mustKey(t *testing.T) identity.KeyPair {
	t.Helper()
	kp, err := identity.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	return kp
}

func TestBuildVerify_RoundTrip(t *testing.T) {
	kp := mustKey(t)
	ev, err := Build(kp.Pub, kp.Priv, []byte("room-1"), 1234, nil, cairnv1.EventType_CHAT, []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if len(ev.EventId) != 32 {
		t.Fatalf("event_id len = %d, want 32", len(ev.EventId))
	}
	if err := Verify(ev); err != nil {
		t.Fatalf("verify freshly built event: %v", err)
	}

	// proto ↔ Go ↔ proto round-trip preserves the id and still verifies.
	wire, err := Encode(ev)
	if err != nil {
		t.Fatal(err)
	}
	back, err := Decode(wire)
	if err != nil {
		t.Fatal(err)
	}
	if string(back.EventId) != string(ev.EventId) {
		t.Fatal("event_id changed across proto round-trip")
	}
	if err := Verify(back); err != nil {
		t.Fatalf("verify decoded event: %v", err)
	}
}

func TestVerify_TamperedPayload(t *testing.T) {
	kp := mustKey(t)
	ev, _ := Build(kp.Pub, kp.Priv, []byte("room-1"), 1, nil, cairnv1.EventType_CHAT, []byte("hi"))
	ev.Payload = []byte("HI") // id no longer matches content
	if err := Verify(ev); !errors.Is(err, ErrIDMismatch) {
		t.Fatalf("want ErrIDMismatch, got %v", err)
	}
}

func TestVerify_TamperedSig(t *testing.T) {
	kp := mustKey(t)
	ev, _ := Build(kp.Pub, kp.Priv, []byte("room-1"), 1, nil, cairnv1.EventType_CHAT, []byte("hi"))
	ev.Sig[0] ^= 0xff
	if err := Verify(ev); !errors.Is(err, ErrBadSig) {
		t.Fatalf("want ErrBadSig, got %v", err)
	}
}

func TestVerify_WrongSigner(t *testing.T) {
	kp := mustKey(t)
	other := mustKey(t)
	ev, _ := Build(kp.Pub, kp.Priv, []byte("room-1"), 1, nil, cairnv1.EventType_CHAT, []byte("hi"))
	ev.SenderPub = other.Pub // claims a different signer; id was over the original
	if err := Verify(ev); err == nil {
		t.Fatal("want error for mismatched signer, got nil")
	}
}

func TestComputeID_ParentOrderInvariant(t *testing.T) {
	kp := mustKey(t)
	p1 := []byte("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	p2 := []byte("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	a, _ := Build(kp.Pub, kp.Priv, []byte("r"), 1, [][]byte{p1, p2}, cairnv1.EventType_CHAT, []byte("x"))
	b, _ := Build(kp.Pub, kp.Priv, []byte("r"), 1, [][]byte{p2, p1}, cairnv1.EventType_CHAT, []byte("x"))
	if string(a.EventId) != string(b.EventId) {
		t.Fatal("event_id depends on parent input order; should be canonicalized")
	}
}

func TestHeads(t *testing.T) {
	kp := mustKey(t)
	root, _ := Build(kp.Pub, kp.Priv, []byte("r"), 1, nil, cairnv1.EventType_CHAT, []byte("root"))
	child, _ := Build(kp.Pub, kp.Priv, []byte("r"), 2, [][]byte{root.EventId}, cairnv1.EventType_CHAT, []byte("child"))
	// Two concurrent children of root → two heads.
	sibA, _ := Build(kp.Pub, kp.Priv, []byte("r"), 3, [][]byte{root.EventId}, cairnv1.EventType_CHAT, []byte("A"))
	sibB, _ := Build(kp.Pub, kp.Priv, []byte("r"), 4, [][]byte{root.EventId}, cairnv1.EventType_CHAT, []byte("B"))

	heads := Heads([]*cairnv1.Event{root, child})
	if len(heads) != 1 || string(heads[0]) != string(child.EventId) {
		t.Fatalf("linear chain should have 1 head (child), got %d", len(heads))
	}

	heads = Heads([]*cairnv1.Event{root, sibA, sibB})
	if len(heads) != 2 {
		t.Fatalf("forked chain should have 2 heads, got %d", len(heads))
	}
}

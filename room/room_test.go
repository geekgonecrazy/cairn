package room

import (
	"bytes"
	"testing"

	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

func TestSealOpen_RoundTrip(t *testing.T) {
	key, err := NewRoomKey()
	if err != nil {
		t.Fatal(err)
	}
	kp, _ := identity.GenerateKey()
	roomID := []byte("room-1")
	var ts int64 = 1720000000000

	chat := &Chat{Text: "hello, cairn"}
	pt, err := EncodePayload(chat)
	if err != nil {
		t.Fatal(err)
	}

	framed, err := Seal(key, 1, kp.Pub, roomID, ts, cairnv1.EventType_CHAT, pt)
	if err != nil {
		t.Fatal(err)
	}

	// Build the real event over the sealed payload and confirm it verifies.
	ev, err := event.Build(kp.Pub, kp.Priv, roomID, ts, nil, cairnv1.EventType_CHAT, framed)
	if err != nil {
		t.Fatal(err)
	}
	if err := event.Verify(ev); err != nil {
		t.Fatalf("encrypted event failed verify: %v", err)
	}

	epoch, out, err := Open(key, ev)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if epoch != 1 {
		t.Fatalf("epoch = %d, want 1", epoch)
	}
	got, err := DecodeChat(out)
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "hello, cairn" {
		t.Fatalf("decrypted text = %q", got.Text)
	}
}

func TestOpen_WrongKeyFails(t *testing.T) {
	key, _ := NewRoomKey()
	other, _ := NewRoomKey()
	kp, _ := identity.GenerateKey()
	pt, _ := EncodePayload(&Chat{Text: "secret"})
	framed, _ := Seal(key, 1, kp.Pub, []byte("r"), 1, cairnv1.EventType_CHAT, pt)
	ev, _ := event.Build(kp.Pub, kp.Priv, []byte("r"), 1, nil, cairnv1.EventType_CHAT, framed)
	if _, _, err := Open(other, ev); err == nil {
		t.Fatal("decrypt with wrong key should fail")
	}
}

func TestOpen_AADTamperFails(t *testing.T) {
	// Moving a sealed payload onto an event with a different ts breaks the AAD
	// bind, so decryption must fail.
	key, _ := NewRoomKey()
	kp, _ := identity.GenerateKey()
	pt, _ := EncodePayload(&Chat{Text: "bind me"})
	framed, _ := Seal(key, 1, kp.Pub, []byte("r"), 100, cairnv1.EventType_CHAT, pt)

	forged := &cairnv1.Event{
		SenderPub: kp.Pub, RoomId: []byte("r"), Ts: 999, // wrong ts
		Type: cairnv1.EventType_CHAT, Payload: framed,
	}
	if _, _, err := Open(key, forged); err == nil {
		t.Fatal("AAD mismatch should fail decryption")
	}
}

func TestPayloadEpoch(t *testing.T) {
	key, _ := NewRoomKey()
	kp, _ := identity.GenerateKey()
	framed, _ := Seal(key, 7, kp.Pub, []byte("r"), 1, cairnv1.EventType_CHAT, []byte("x"))
	ep, err := PayloadEpoch(framed)
	if err != nil || ep != 7 {
		t.Fatalf("PayloadEpoch = %d, %v; want 7", ep, err)
	}
}

func TestReactionRoundTrip(t *testing.T) {
	r := &Reaction{Target: []byte("evt"), Emoji: []string{"👍", "🎉"}}
	b, err := EncodePayload(r)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeReaction(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Emoji) != 2 || got.Emoji[0] != "👍" || !bytes.Equal(got.Target, []byte("evt")) {
		t.Fatalf("reaction round-trip mismatch: %+v", got)
	}
}

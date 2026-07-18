package event

import (
	"bytes"
	"encoding/hex"
	"testing"

	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// Golden conformance vectors: fixed envelope fields → canonical event_id. The
// SAME vectors and expected ids are asserted in the webapp (npm run conformance),
// so any drift in either impl's canonical CBOR / BLAKE3 fails a test rather than
// silently breaking Go↔browser interop. If you change the canonical encoding on
// purpose, regenerate both sides (values live in webapp/scripts/conformance.ts).
func rep(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

var conformanceVectors = []struct {
	ev   *cairnv1.Event
	want string
}{
	{
		ev:   &cairnv1.Event{SenderPub: rep(0x01), RoomId: []byte("general"), Ts: 1720000000000, Type: cairnv1.EventType_CHAT, Payload: []byte("hello")},
		want: "1a0c4f0f94d12884427a8597e6c73a032982ec4dc00a846f055e3d4a38a2b981",
	},
	{
		// parents supplied unsorted → must canonicalize to the same id.
		ev:   &cairnv1.Event{SenderPub: rep(0x01), RoomId: []byte("general"), Ts: 1720000000000, Parents: [][]byte{rep(0x03), rep(0x02)}, Type: cairnv1.EventType_REACTION, Payload: []byte{}},
		want: "06281b061cca3fd6d097a851406073d557dee7cb5013443c9352fe3c17f6b79c",
	},
	{
		ev:   &cairnv1.Event{SenderPub: rep(0xab), RoomId: []byte(""), Ts: 0, Parents: [][]byte{rep(0x02)}, Type: cairnv1.EventType_MEMBER_ADD, Payload: []byte{0xde, 0xad, 0xbe, 0xef}},
		want: "9f6a473a69862f4077c25656c174179e4e5d6c703ecce91dbf3baea32b55246f",
	},
}

func TestConformanceVectors(t *testing.T) {
	for i, v := range conformanceVectors {
		id, err := ComputeID(v.ev)
		if err != nil {
			t.Fatal(err)
		}
		if got := hex.EncodeToString(id[:]); got != v.want {
			t.Errorf("V%d event_id = %s, want %s", i+1, got, v.want)
		}
	}
}

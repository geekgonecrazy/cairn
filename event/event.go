// Package event implements the Cairn event envelope: canonical content,
// content-addressed event_id, and signature. The SAME signed bytes travel over
// every transport; the payload is opaque (CBOR encrypted under the room key by
// package room). See PROTOCOL.md §2.
//
// Canonical content (deterministic CBOR array, RFC 8949 §4.2):
//
//	content  = det-CBOR([ sender_pub, room_id, ts, sort(parents), int(type), payload ])
//	event_id = BLAKE3-256(content)
//	sig      = Ed25519(sender_priv, event_id)
//
// event_id and sig are DERIVED from content and are excluded from it. parents
// are sorted ascending before hashing so the id is canonical regardless of the
// order the caller supplied them.
package event

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"sort"

	"google.golang.org/protobuf/proto"
	"lukechampine.com/blake3"

	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// Errors from Verify.
var (
	ErrIDMismatch = errors.New("event: event_id does not match canonical content")
	ErrBadSig     = errors.New("event: signature does not verify")
)

// SortParents returns a copy of parents sorted ascending by byte value, the
// canonical order used when hashing. Exported because the DAG and store rely on
// the same ordering.
func SortParents(parents [][]byte) [][]byte {
	out := make([][]byte, len(parents))
	copy(out, parents)
	sort.Slice(out, func(i, j int) bool { return bytes.Compare(out[i], out[j]) < 0 })
	return out
}

// canonicalContent encodes the signed tuple as a deterministic-CBOR array.
func canonicalContent(senderPub, roomID []byte, ts int64, parents [][]byte, typ cairnv1.EventType, payload []byte) ([]byte, error) {
	tuple := []any{senderPub, roomID, ts, SortParents(parents), int64(typ), payload}
	return identity.Marshal(tuple)
}

// ComputeID recomputes the BLAKE3-256 content address for ev's fields. It does
// not consult ev.EventId (that is what Verify checks against).
func ComputeID(ev *cairnv1.Event) ([32]byte, error) {
	content, err := canonicalContent(ev.SenderPub, ev.RoomId, ev.Ts, ev.Parents, ev.Type, ev.Payload)
	if err != nil {
		return [32]byte{}, err
	}
	return blake3.Sum256(content), nil
}

// Build assembles a signed Event. parents may be supplied in any order; they
// are stored sorted so the wire form matches the canonical (hashed) form. priv
// is the device/session key whose public half is senderPub. The payload is
// passed through verbatim — encryption/framing is package room's job.
//
// Passkey-signed authority events (Phase 5) replace the Ed25519 sig with a
// WebAuthn envelope; Build covers the Phase 0/1 plain-Ed25519 case.
func Build(senderPub []byte, priv ed25519.PrivateKey, roomID []byte, ts int64, parents [][]byte, typ cairnv1.EventType, payload []byte) (*cairnv1.Event, error) {
	ev := &cairnv1.Event{
		SenderPub: senderPub,
		RoomId:    roomID,
		Ts:        ts,
		Parents:   SortParents(parents),
		Type:      typ,
		Payload:   payload,
	}
	id, err := ComputeID(ev)
	if err != nil {
		return nil, err
	}
	ev.EventId = id[:]
	ev.Sig = ed25519.Sign(priv, ev.EventId)
	return ev, nil
}

// Verify checks structural + cryptographic integrity: that ev.EventId equals
// the BLAKE3 of its canonical content, and that ev.Sig is a valid Ed25519
// signature over that id by ev.SenderPub.
//
// It does NOT establish trust — proving sender_pub belongs to a member of a
// household you recognize is identity.VerifySender's job (a separate chain
// walk). A valid Verify with an unknown sender is a well-formed event from a
// stranger.
func Verify(ev *cairnv1.Event) error {
	id, err := ComputeID(ev)
	if err != nil {
		return err
	}
	if !bytes.Equal(id[:], ev.EventId) {
		return ErrIDMismatch
	}
	if len(ev.SenderPub) != ed25519.PublicKeySize || len(ev.Sig) != ed25519.SignatureSize {
		return ErrBadSig
	}
	if !ed25519.Verify(ev.SenderPub, ev.EventId, ev.Sig) {
		return ErrBadSig
	}
	return nil
}

// Encode / Decode are the protobuf wire form of an Event — the same bytes on
// every transport. arrived_via is a receiver-local annotation and rides along
// but is never part of the signed content.
func Encode(ev *cairnv1.Event) ([]byte, error) { return proto.Marshal(ev) }

func Decode(b []byte) (*cairnv1.Event, error) {
	var ev cairnv1.Event
	if err := proto.Unmarshal(b, &ev); err != nil {
		return nil, err
	}
	return &ev, nil
}

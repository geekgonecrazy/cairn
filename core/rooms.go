package core

// Room and space state, folded out of the signed event stream.
//
// Rooms are NOT pre-seeded and are not created by an API call: a room exists
// because someone emitted a signed ROOM_CREATE, and a member belongs to it
// because someone emitted a signed MEMBER_ADD. The tables in `store` are a
// materialized view over those events, so a node that syncs the DAG from a peer
// reconstructs the same rooms without anyone telling it to.
//
// Membership is keyed on the MEMBER ROOT (models.Member.MemberPub), never a
// device or session key — a member's rooms follow them onto every device they
// pair, and survive a session key rotating.

import (
	"fmt"

	"github.com/fxamacker/cbor/v2"

	"github.com/geekgonecrazy/cairn/models"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// roomStatePayload is the cleartext CBOR carried by room-state events. These
// events are epoch-0 (unencrypted) because a node that is not yet a member must
// still be able to fold them — you cannot learn you were admitted from a
// payload encrypted under a key the admit is granting you.
type roomStatePayload struct {
	// ROOM_CREATE
	Name    string `cbor:"name"`
	SpaceID []byte `cbor:"space_id"`
	// SPACE_CREATE
	SpaceName   string `cbor:"space_name"`
	AdmitKind   string `cbor:"admit_kind"`
	AdmitOrigin string `cbor:"admit_origin"`
	// MEMBER_ADD / MEMBER_REMOVE
	MemberPub []byte `cbor:"member_pub"`
	Role      string `cbor:"role"`
}

// decodeRoomState strips the uvarint(0) epoch frame and decodes the payload.
func decodeRoomState(payload []byte) (*roomStatePayload, error) {
	if len(payload) == 0 {
		return nil, fmt.Errorf("core: empty room-state payload")
	}
	// Room-state events are always epoch 0, so the frame is a single 0x00 byte.
	if payload[0] != 0x00 {
		return nil, fmt.Errorf("core: room-state payload is not epoch 0")
	}
	var p roomStatePayload
	if err := cbor.Unmarshal(payload[1:], &p); err != nil {
		return nil, fmt.Errorf("core: decode room-state payload: %w", err)
	}
	return &p, nil
}

// applyRoomState folds a room-state event into the materialized tables. Called
// after the event has been verified and stored, so a failure here is a data
// problem to log, not a reason to reject an event that already verifies.
func applyRoomState(ev *cairnv1.Event) error {
	p, err := decodeRoomState(ev.Payload)
	if err != nil {
		return err
	}
	st := Store()

	switch ev.Type {
	case cairnv1.EventType_SPACE_CREATE:
		return st.PutSpace(&models.Space{
			SpaceID:     ev.RoomId, // a space_create names the space in room_id
			Name:        p.SpaceName,
			AdmitKind:   p.AdmitKind,
			AdmitOrigin: p.AdmitOrigin,
		})

	case cairnv1.EventType_ROOM_CREATE:
		return st.PutRoom(&models.Room{
			RoomID:    ev.RoomId,
			SpaceID:   p.SpaceID,
			Name:      p.Name,
			CreatedAt: ev.Ts,
		})

	case cairnv1.EventType_MEMBER_ADD:
		if len(p.MemberPub) != 32 {
			return fmt.Errorf("core: member_add without a valid member_pub")
		}
		role := p.Role
		if role == "" {
			role = "member"
		}
		return st.PutMember(&models.Member{
			RoomID:     ev.RoomId,
			MemberPub:  p.MemberPub,
			Role:       role,
			AddedEvent: ev.EventId,
		})
	}
	return nil
}

// isRoomStateEvent reports whether an event carries room/space membership state
// that must be folded into the materialized tables.
func isRoomStateEvent(t cairnv1.EventType) bool {
	switch t {
	case cairnv1.EventType_SPACE_CREATE,
		cairnv1.EventType_ROOM_CREATE,
		cairnv1.EventType_MEMBER_ADD:
		return true
	}
	return false
}

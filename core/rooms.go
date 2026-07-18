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
	"bytes"
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
	Name       string `cbor:"name"`
	SpaceID    []byte `cbor:"space_id"`
	Visibility string `cbor:"visibility"` // "discoverable" | "hidden"
	// SPACE_CREATE
	SpaceName   string `cbor:"space_name"`
	AdmitKind   string `cbor:"admit_kind"`
	AdmitOrigin string `cbor:"admit_origin"`
	// MEMBER_ADD / MEMBER_REMOVE / SPACE_MEMBER_ADD
	MemberPub []byte `cbor:"member_pub"`
	Role      string `cbor:"role"`
	// ROOM_JOIN_REQUEST
	Reason string `cbor:"reason"`
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
	case cairnv1.EventType_SPACE_CREATE, cairnv1.EventType_SPACE_UPDATE:
		// Both name the space in room_id and carry its full state; an update is a
		// PutSpace with the new name/policy. The modal always sends the complete
		// policy, so this overwrites rather than merges.
		return st.PutSpace(&models.Space{
			SpaceID:     ev.RoomId,
			Name:        p.SpaceName,
			AdmitKind:   p.AdmitKind,
			AdmitOrigin: p.AdmitOrigin,
		})

	case cairnv1.EventType_ROOM_CREATE:
		visibility := p.Visibility
		if visibility != "hidden" {
			// Anything unset or unrecognised defaults to discoverable — a room is
			// only invisible when its author deliberately said so.
			visibility = "discoverable"
		}
		return st.PutRoom(&models.Room{
			RoomID:     ev.RoomId,
			SpaceID:    p.SpaceID,
			Name:       p.Name,
			CreatedAt:  ev.Ts,
			Visibility: visibility,
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

	case cairnv1.EventType_MEMBER_REMOVE:
		// Drops the member from the room roster. The remover pairs this with a
		// ROOM_KEY_ROTATE wrapped to the REMAINING members, so the removed member
		// cannot read the new epoch — but pre-removal history they already hold
		// stays readable (keys cannot be un-shared).
		if len(p.MemberPub) != 32 {
			return fmt.Errorf("core: member_remove without a valid member_pub")
		}
		return st.DeleteMember(ev.RoomId, p.MemberPub)

	case cairnv1.EventType_SPACE_MEMBER_ADD:
		// A space_member_add names the space in room_id, exactly as space_create
		// does. It grants discovery only — no key rides it.
		if len(p.MemberPub) != 32 {
			return fmt.Errorf("core: space_member_add without a valid member_pub")
		}
		role := p.Role
		if role == "" {
			role = "member"
		}
		return st.PutSpaceMember(&models.SpaceMember{
			SpaceID:    ev.RoomId,
			MemberPub:  p.MemberPub,
			Role:       role,
			AddedEvent: ev.EventId,
		})

	case cairnv1.EventType_ROOM_JOIN_REQUEST:
		if len(p.MemberPub) != 32 {
			return fmt.Errorf("core: room_join_request without a valid member_pub")
		}
		return st.PutJoinRequest(&models.JoinRequest{
			RoomID:       ev.RoomId,
			MemberPub:    p.MemberPub,
			Reason:       p.Reason,
			RequestEvent: ev.EventId,
			RequestedAt:  ev.Ts,
		})

	case cairnv1.EventType_SPACE_MEMBER_REMOVE:
		// Revokes the discovery grant: drop the member from the space roster. Their
		// individual room memberships are untouched — those are removed per-room.
		if len(p.MemberPub) != 32 {
			return fmt.Errorf("core: space_member_remove without a valid member_pub")
		}
		return st.DeleteSpaceMember(ev.RoomId, p.MemberPub)
	}
	return nil
}

// VisibleRoom is a room a member can see, tagged with whether they actually hold
// membership (joined) or can only discover it through space membership.
type VisibleRoom struct {
	Room   *models.Room
	Joined bool
	// PendingRequests is the number of ROOM_JOIN_REQUESTs for this room whose
	// requester is not yet a member — the "waiting to be admitted" count. Only
	// populated for rooms the caller is a member of (a discoverer must not learn
	// who else is asking); 0 otherwise.
	PendingRequests int
}

// VisibleRooms computes what memberPub can see, across the two membership tiers:
//
//   - Rooms a MEMBER_ADD admitted them to → Joined=true (readable).
//   - The discoverable rooms of every SPACE they belong to → Joined=false
//     (visible but locked; joining means a ROOM_JOIN_REQUEST a member answers).
//
// A hidden room is returned only to a member who was actually admitted — space
// membership alone never reveals it. Spaces are returned when they hold a
// visible room OR the member belongs to them directly (so an empty space they
// were just added to still shows). This is the single source of truth for the
// sidebar; the controller only shapes it onto the wire.
func VisibleRooms(memberPub []byte) ([]VisibleRoom, []*models.Space, error) {
	spaceMemberships, err := st.SpaceMembershipsFor(memberPub)
	if err != nil {
		return nil, nil, err
	}
	memberOfSpace := map[string]bool{}
	for _, sm := range spaceMemberships {
		memberOfSpace[string(sm.SpaceID)] = true
	}

	rooms, err := st.ListRooms()
	if err != nil {
		return nil, nil, err
	}

	visibleSpaces := map[string]bool{}
	for sid := range memberOfSpace {
		visibleSpaces[sid] = true
	}
	var out []VisibleRoom
	for _, r := range rooms {
		members, err := st.ListMembers(r.RoomID)
		if err != nil {
			return nil, nil, err
		}
		joined := false
		for _, m := range members {
			if bytes.Equal(m.MemberPub, memberPub) {
				joined = true
				break
			}
		}
		// Empty visibility is treated as discoverable (fold normalises it; a
		// legacy row may predate the column).
		discoverable := r.Visibility != "hidden"
		inMemberSpace := len(r.SpaceID) > 0 && memberOfSpace[string(r.SpaceID)]
		if !joined && !(inMemberSpace && discoverable) {
			continue
		}

		// Pending join requests, but only for members — a discoverer must not see
		// who else is asking. Pending = a request whose member is not yet admitted.
		pending := 0
		if joined {
			reqs, err := st.ListJoinRequests(r.RoomID)
			if err != nil {
				return nil, nil, err
			}
			for _, rq := range reqs {
				admitted := false
				for _, m := range members {
					if bytes.Equal(m.MemberPub, rq.MemberPub) {
						admitted = true
						break
					}
				}
				if !admitted {
					pending++
				}
			}
		}

		out = append(out, VisibleRoom{Room: r, Joined: joined, PendingRequests: pending})
		if len(r.SpaceID) > 0 {
			visibleSpaces[string(r.SpaceID)] = true
		}
	}

	allSpaces, err := st.ListSpaces()
	if err != nil {
		return nil, nil, err
	}
	var spaces []*models.Space
	for _, sp := range allSpaces {
		if visibleSpaces[string(sp.SpaceID)] {
			spaces = append(spaces, sp)
		}
	}
	return out, spaces, nil
}

// isRoomStateEvent reports whether an event carries room/space membership state
// that must be folded into the materialized tables.
func isRoomStateEvent(t cairnv1.EventType) bool {
	switch t {
	case cairnv1.EventType_SPACE_CREATE,
		cairnv1.EventType_SPACE_UPDATE,
		cairnv1.EventType_ROOM_CREATE,
		cairnv1.EventType_MEMBER_ADD,
		cairnv1.EventType_MEMBER_REMOVE,
		cairnv1.EventType_SPACE_MEMBER_ADD,
		cairnv1.EventType_SPACE_MEMBER_REMOVE,
		cairnv1.EventType_ROOM_JOIN_REQUEST:
		return true
	}
	return false
}

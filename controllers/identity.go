package controllers

// Identity-log transport. The server is a CARRIER, not an authority: it
// verifies that each object's signature checks out against the key the object
// itself names, then stores and serves it. It never mints identity, never
// decides which households are trustworthy, and never asserts anything a client
// could not re-derive from the bytes alone. Clients re-verify everything.

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	"github.com/geekgonecrazy/cairn/core"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// PutIdentityObject accepts one CBOR identity-log object, verifies its
// signature, and stores it. The object type is discriminated by which fields
// decode — the CBOR carries no type tag, so we try each shape and require
// exactly one to both decode cleanly and verify.
func (CairnController) PutIdentityObject(
	_ context.Context,
	req *connect.Request[cairnv1.PutIdentityObjectRequest],
) (*connect.Response[cairnv1.PutIdentityObjectResponse], error) {
	blob := req.Msg.GetCbor()
	if len(blob) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("empty object"))
	}

	hash, err := storeIdentityObject(blob)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&cairnv1.PutIdentityObjectResponse{Hash: hash}), nil
}

// storeIdentityObject dispatches on the object's signed `type` tag, then
// verifies it as exactly that shape. No speculative decoding: the tag is inside
// the signed bytes, so an object cannot be filed as a type its issuer did not
// sign it as (identity.TypeAttestation and friends).
func storeIdentityObject(blob []byte) ([]byte, error) {
	st := core.Store()

	tag, err := identity.ObjectType(blob)
	if err != nil {
		return nil, err
	}

	switch tag {
	case identity.TypeAttestation:
		var att identity.IdentityAttestation
		if err := identity.Unmarshal(blob, &att); err != nil {
			return nil, fmt.Errorf("decode attestation: %w", err)
		}
		if !identity.VerifyAttestation(&att) {
			return nil, errors.New("attestation signature does not verify")
		}
		if err := st.PutAttestation(&att); err != nil {
			return nil, err
		}
		return identityHash(&att)

	case identity.TypeDeviceDelegation:
		var dd identity.DeviceDelegation
		if err := identity.Unmarshal(blob, &dd); err != nil {
			return nil, fmt.Errorf("decode device delegation: %w", err)
		}
		if !identity.VerifyDeviceDelegation(&dd) {
			return nil, errors.New("device delegation signature does not verify")
		}
		if err := st.PutDeviceDelegation(&dd); err != nil {
			return nil, err
		}
		return identityHash(&dd)

	case identity.TypeSessionDelegation:
		var sd identity.SessionDelegation
		if err := identity.Unmarshal(blob, &sd); err != nil {
			return nil, fmt.Errorf("decode session delegation: %w", err)
		}
		if !identity.VerifySessionDelegation(&sd) {
			return nil, errors.New("session delegation signature does not verify")
		}
		if err := st.PutSessionDelegation(&sd); err != nil {
			return nil, err
		}
		return identityHash(&sd)

	case identity.TypeDeviceRevoke:
		var dr identity.DeviceRevoke
		if err := identity.Unmarshal(blob, &dr); err != nil {
			return nil, fmt.Errorf("decode device revoke: %w", err)
		}
		if !identity.VerifyDeviceRevoke(&dr) {
			return nil, errors.New("device revoke signature does not verify")
		}
		if err := st.PutDeviceRevoke(&dr); err != nil {
			return nil, err
		}
		return identityHash(&dr)

	default:
		return nil, fmt.Errorf("unknown identity object type %q", tag)
	}
}

func identityHash(v any) ([]byte, error) {
	h, err := identity.Hash(v)
	if err != nil {
		return nil, fmt.Errorf("hash identity object: %w", err)
	}
	return h[:], nil
}

// ListRooms returns what memberPub can see, across two tiers:
//
//   - Rooms a MEMBER_ADD admitted them to — returned with joined=true. They hold
//     (or will be wrapped) the key and can read the room.
//   - The discoverable rooms of every SPACE they are a member of — returned with
//     joined=false. They can see the room exists but hold no key; getting in
//     means a ROOM_JOIN_REQUEST an existing member answers with a MEMBER_ADD.
//
// A `hidden` room is returned only to someone a MEMBER_ADD actually admitted —
// space membership alone never reveals it. There is still no "default" or
// "public" room: a household starts with no spaces and no rooms, so a brand-new
// member with no space membership gets an empty list, which the UI renders as an
// empty sidebar rather than inventing channels.
func (CairnController) ListRooms(
	_ context.Context,
	req *connect.Request[cairnv1.ListRoomsRequest],
) (*connect.Response[cairnv1.ListRoomsResponse], error) {
	memberPub := req.Msg.GetMemberPub()
	if len(memberPub) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("member_pub must be 32 bytes"))
	}

	rooms, spaces, err := core.VisibleRooms(memberPub)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	out := &cairnv1.ListRoomsResponse{}
	for _, vr := range rooms {
		out.Rooms = append(out.Rooms, &cairnv1.RoomInfo{
			RoomId:          vr.Room.RoomID,
			SpaceId:         vr.Room.SpaceID,
			Name:            vr.Room.Name,
			CreatedAt:       vr.Room.CreatedAt,
			Joined:          vr.Joined,
			Visibility:      vr.Room.Visibility,
			PendingRequests: int32(vr.PendingRequests),
		})
	}
	for _, sp := range spaces {
		out.Spaces = append(out.Spaces, &cairnv1.SpaceInfo{
			SpaceId:     sp.SpaceID,
			Name:        sp.Name,
			AdmitKind:   sp.AdmitKind,
			AdmitOrigin: sp.AdmitOrigin,
			Owner:       sp.Owner,
		})
	}
	return connect.NewResponse(out), nil
}

// ListSpaceMembers returns a space's roster — the member roots a SPACE_MEMBER_ADD
// admitted to it. Names are not included: the client resolves them from the
// identity log (ResolveSender) and shows a name only for a chain that verifies to
// our own household, exactly as it does for a room roster.
func (CairnController) ListSpaceMembers(
	_ context.Context,
	req *connect.Request[cairnv1.ListSpaceMembersRequest],
) (*connect.Response[cairnv1.ListSpaceMembersResponse], error) {
	spaceID := req.Msg.GetSpaceId()
	if len(spaceID) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("space_id is required"))
	}
	members, err := core.Store().ListSpaceMembers(spaceID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := &cairnv1.ListSpaceMembersResponse{}
	for _, m := range members {
		out.Members = append(out.Members, &cairnv1.SpaceMemberInfo{
			MemberPub: m.MemberPub,
			Role:      m.Role,
		})
	}
	return connect.NewResponse(out), nil
}

// ListMemberDevices returns the device keys a room key must be wrapped to for a
// member. Room keys seal to DEVICE keys — the member root is offline and holds
// no live secret — so a client admitting someone needs their whole device set,
// minus anything revoked or descended from something revoked.
//
// Like every other identity endpoint this is a LOOKUP, not an assertion: the
// client can (and does) re-derive the same set from the delegations it fetches.
// The worst a lying server can do is omit a device, which locks that device out
// of new epochs — visible to its owner — or name an extra key, which wraps the
// epoch key to a stranger. The latter is why a client must not wrap blindly to
// whatever this returns for a member it has not verified.
func (CairnController) ListMemberDevices(
	_ context.Context,
	req *connect.Request[cairnv1.ListMemberDevicesRequest],
) (*connect.Response[cairnv1.ListMemberDevicesResponse], error) {
	memberPub := req.Msg.GetMemberPub()
	if len(memberPub) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("member_pub must be 32 bytes"))
	}
	devices, err := core.Store().DevicesUnder(memberPub)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&cairnv1.ListMemberDevicesResponse{DevicePubs: devices}), nil
}

// ResolveSender returns every identity-log object needed to place senderPub,
// in one round trip. Objects are returned as raw CBOR so the client verifies
// them itself — this endpoint is a lookup, not an assertion of trust.
//
// Missing links come back empty rather than as an error: a partially-known
// sender is a normal state during sync, and the client decides what to do about
// it (usually: render an honest "unverified sender" instead of a name).
func (CairnController) ResolveSender(
	_ context.Context,
	req *connect.Request[cairnv1.ResolveSenderRequest],
) (*connect.Response[cairnv1.ResolveSenderResponse], error) {
	senderPub := req.Msg.GetSenderPub()
	if len(senderPub) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("sender_pub must be 32 bytes"))
	}
	st := core.Store()
	out := &cairnv1.ResolveSenderResponse{}

	// A sender key is either a session key (one hop from a device) or a device
	// key directly — native clients and agents sign without a session tier.
	devicePub := senderPub
	if sd, ok := st.SessionDelegation(senderPub); ok {
		if b, err := identity.Marshal(sd); err == nil {
			out.SessionDelegation = b
		}
		devicePub = sd.DevicePub
	}

	// Climb the delegation tree, leaf first. Devices pair devices, so this is a
	// walk: the client cannot verify the sender without every link above it.
	// Bounded by the same depth limit the verifier uses, and by a visited set —
	// this walks whatever a stranger managed to put in the log, so a cycle here
	// would hang the request.
	memberPub := []byte(nil)
	seen := map[string]bool{}
	cur := devicePub
	for range identity.MaxChainDepth {
		if seen[string(cur)] {
			break
		}
		seen[string(cur)] = true

		// Report a revocation whether or not the delegation survives, so a client
		// that only ever sees the revoke still reaches the right conclusion.
		if dr, ok := st.DeviceRevokeFor(cur); ok {
			if b, err := identity.Marshal(dr); err == nil {
				out.DeviceRevokes = append(out.DeviceRevokes, b)
			}
		}

		dd, ok := st.DeviceDelegation(cur)
		if !ok {
			// No delegation: cur is a member root (or unknown).
			memberPub = cur
			break
		}
		if b, err := identity.Marshal(dd); err == nil {
			out.DeviceDelegations = append(out.DeviceDelegations, b)
		}
		cur = dd.ParentPub
	}

	// The key may BE a member root rather than a device/session key — that is how
	// a client looks up a room member it has never seen send a message, since
	// membership is recorded as member roots. Fall back to a direct attestation
	// lookup so member rosters can show names instead of key stubs.
	if len(memberPub) == 0 {
		memberPub = senderPub
	}
	if att, ok := st.Attestation(memberPub); ok {
		if b, err := identity.Marshal(att); err == nil {
			out.Attestation = b
		}
	}

	return connect.NewResponse(out), nil
}

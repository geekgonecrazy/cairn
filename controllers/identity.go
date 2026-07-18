package controllers

// Identity-log transport. The server is a CARRIER, not an authority: it
// verifies that each object's signature checks out against the key the object
// itself names, then stores and serves it. It never mints identity, never
// decides which households are trustworthy, and never asserts anything a client
// could not re-derive from the bytes alone. Clients re-verify everything.

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	"github.com/geekgonecrazy/cairn/core"
	"github.com/geekgonecrazy/cairn/identity"
	"github.com/geekgonecrazy/cairn/models"
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

// ListRooms returns the rooms memberPub has been admitted to, plus the spaces
// containing them.
//
// There is no "default" or "public" room: a household starts with none, and a
// member sees only what a signed MEMBER_ADD put them in. A caller who is in
// nothing gets an empty list, which the UI renders as an empty sidebar with a
// create affordance rather than inventing channels.
func (CairnController) ListRooms(
	_ context.Context,
	req *connect.Request[cairnv1.ListRoomsRequest],
) (*connect.Response[cairnv1.ListRoomsResponse], error) {
	memberPub := req.Msg.GetMemberPub()
	if len(memberPub) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("member_pub must be 32 bytes"))
	}
	st := core.Store()

	rooms, err := st.ListRooms()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	out := &cairnv1.ListRoomsResponse{}
	spaceIDs := map[string]bool{}
	for _, r := range rooms {
		members, err := st.ListMembers(r.RoomID)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		if !containsMember(members, memberPub) {
			continue // not admitted: the room is not theirs to see
		}
		out.Rooms = append(out.Rooms, &cairnv1.RoomInfo{
			RoomId:    r.RoomID,
			SpaceId:   r.SpaceID,
			Name:      r.Name,
			CreatedAt: r.CreatedAt,
		})
		if len(r.SpaceID) > 0 {
			spaceIDs[string(r.SpaceID)] = true
		}
	}

	spaces, err := st.ListSpaces()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	for _, sp := range spaces {
		if spaceIDs[string(sp.SpaceID)] {
			out.Spaces = append(out.Spaces, &cairnv1.SpaceInfo{
				SpaceId: sp.SpaceID,
				Name:    sp.Name,
			})
		}
	}
	return connect.NewResponse(out), nil
}

func containsMember(members []*models.Member, memberPub []byte) bool {
	for _, m := range members {
		if bytes.Equal(m.MemberPub, memberPub) {
			return true
		}
	}
	return false
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

	memberPub := []byte(nil)
	if dd, ok := st.DeviceDelegation(devicePub); ok {
		if b, err := identity.Marshal(dd); err == nil {
			out.DeviceDelegation = b
		}
		memberPub = dd.MemberPub
	}

	// Revocations must be reported even when the delegation is gone, so a client
	// that only ever sees the revoke still reaches the right conclusion.
	if dr, ok := st.DeviceRevokeFor(devicePub); ok {
		if b, err := identity.Marshal(dr); err == nil {
			out.DeviceRevoke = b
		}
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

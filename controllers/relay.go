package controllers

// Relay access + directory endpoints (slices 2–3). Operational admission — who
// may use this relay, and who it will name — not identity trust
// (docs/adrs/0014-relay-operational-admission.md).

import (
	"context"

	"connectrpc.com/connect"

	"github.com/geekgonecrazy/cairn/core"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// RelayInfo returns this relay's public key. A client pins it to know it is
// talking to the right relay, and verifies invite tokens against it.
func (CairnController) RelayInfo(
	_ context.Context,
	_ *connect.Request[cairnv1.RelayInfoRequest],
) (*connect.Response[cairnv1.RelayInfoResponse], error) {
	return connect.NewResponse(&cairnv1.RelayInfoResponse{
		RelayPub:      core.RelayPub(),
		RequireInvite: core.RelayRequiresInvite(),
	}), nil
}

// RedeemInvite exchanges a relay-signed, single-use invite for a place on the
// allow-list. The invite carries no member identity — the redeemer names the
// member root to admit, and the relay records the invite id as consumed so it
// cannot be reused.
func (CairnController) RedeemInvite(
	_ context.Context,
	req *connect.Request[cairnv1.RedeemInviteRequest],
) (*connect.Response[cairnv1.RedeemInviteResponse], error) {
	if err := core.RedeemInvite(req.Msg.GetInvite(), req.Msg.GetMemberPub()); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&cairnv1.RedeemInviteResponse{}), nil
}

// Directory returns the relay's allow-listed members that have published a
// self-attestation, with their self-asserted profile — what add-by-name browses.
// The name is a label (the "relay-vouched" tier); the pubkey is the identity.
func (CairnController) Directory(
	_ context.Context,
	_ *connect.Request[cairnv1.DirectoryRequest],
) (*connect.Response[cairnv1.DirectoryResponse], error) {
	entries, err := core.Directory()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := &cairnv1.DirectoryResponse{}
	for _, e := range entries {
		out.Members = append(out.Members, &cairnv1.DirectoryEntry{
			MemberPub:   e.MemberPub,
			DisplayName: e.DisplayName,
			Kind:        e.Kind,
		})
	}
	return connect.NewResponse(out), nil
}

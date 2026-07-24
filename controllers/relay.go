package controllers

// Relay access endpoints (slice 2). Operational admission — who may use this
// relay — not identity trust (docs/decisions.md §Trust model v2).

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
	return connect.NewResponse(&cairnv1.RelayInfoResponse{RelayPub: core.RelayPub()}), nil
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

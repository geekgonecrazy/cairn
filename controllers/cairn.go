// Package controllers holds the transport-facing handlers: the ConnectRPC
// CairnService implementation and the SSE realtime stream. Handlers are thin —
// they translate the wire request into a core call and shape the response.
package controllers

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	"github.com/geekgonecrazy/cairn/core"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
	"github.com/geekgonecrazy/cairn/proto/cairnv1/cairnv1connect"
)

// CairnController implements cairnv1connect.CairnServiceHandler.
type CairnController struct{}

var _ cairnv1connect.CairnServiceHandler = CairnController{}

// SendEvent verifies + stores + fans out a signed event.
func (CairnController) SendEvent(_ context.Context, req *connect.Request[cairnv1.SendEventRequest]) (*connect.Response[cairnv1.SendEventResponse], error) {
	ev := req.Msg.GetEvent()
	if ev == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("missing event"))
	}
	if err := core.SubmitEvent(ev); err != nil {
		return nil, connect.NewError(submitErrorCode(err), err)
	}
	return connect.NewResponse(&cairnv1.SendEventResponse{EventId: ev.GetEventId()}), nil
}

// submitErrorCode classifies a SubmitEvent failure so the client knows whether to
// retry. FailedPrecondition is RECOVERABLE — the carrier lacks identity objects it
// can be given (a chain link hasn't been pushed yet); the client publishes its
// identity and retries. PermissionDenied is TERMINAL — the sender is revoked or
// expired, or a signature is forged; retrying changes nothing. InvalidArgument is
// a malformed event.
func submitErrorCode(err error) connect.Code {
	switch {
	case errors.Is(err, identity.ErrUnknownObject):
		return connect.CodeFailedPrecondition
	case errors.Is(err, identity.ErrRevoked),
		errors.Is(err, identity.ErrExpired),
		errors.Is(err, identity.ErrBadSignature):
		return connect.CodePermissionDenied
	default:
		return connect.CodeInvalidArgument
	}
}

// Sync returns the subgraph the client is missing plus the server's heads.
func (CairnController) Sync(_ context.Context, req *connect.Request[cairnv1.SyncRequest]) (*connect.Response[cairnv1.SyncResponse], error) {
	roomID := req.Msg.GetRoomId()
	missing, err := core.Store().Missing(roomID, req.Msg.GetHaveHeads())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	heads, err := core.Store().Heads(roomID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&cairnv1.SyncResponse{Missing: missing, Heads: heads}), nil
}

// History backfills older events by walking parents.
func (CairnController) History(_ context.Context, req *connect.Request[cairnv1.HistoryRequest]) (*connect.Response[cairnv1.HistoryResponse], error) {
	events, err := core.Store().History(req.Msg.GetRoomId(), req.Msg.GetBefore(), int(req.Msg.GetLimit()))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&cairnv1.HistoryResponse{Events: events}), nil
}

// GetIdentityObject serves a raw CBOR identity-log object by hash.
func (CairnController) GetIdentityObject(_ context.Context, req *connect.Request[cairnv1.GetIdentityObjectRequest]) (*connect.Response[cairnv1.GetIdentityObjectResponse], error) {
	blob, err := core.Store().GetIdentityObject(req.Msg.GetHash())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if blob == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("identity object not found"))
	}
	return connect.NewResponse(&cairnv1.GetIdentityObjectResponse{Cbor: blob}), nil
}

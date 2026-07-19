// Command smoke is a throwaway Phase 0 end-to-end check: build a signed event,
// SendEvent it over the Connect API, then Sync it back and confirm the id and
// signature survive the round-trip proto ↔ Go ↔ server ↔ Go. Not part of the
// product; run against a live cairnd. (Delete once webapp covers this path.)
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"

	"connectrpc.com/connect"

	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
	"github.com/geekgonecrazy/cairn/proto/cairnv1/cairnv1connect"
)

func main() {
	base := "http://127.0.0.1:8099"
	if len(os.Args) > 1 {
		base = os.Args[1]
	}
	client := cairnv1connect.NewCairnServiceClient(http.DefaultClient, base)
	ctx := context.Background()

	kp, err := identity.GenerateKey()
	if err != nil {
		log.Fatal(err)
	}
	room := []byte("smoke-room")

	// The carrier enforces the chain gate: it accepts an event only from a sender
	// that chains to a trusted household root. As a standalone client, we ARE our
	// own household of one — publishing our self-attestation founds it on a fresh
	// carrier (adoption) so our events verify. Skipping this yields PermissionDenied.
	//
	// Events are signed by the DERIVED DEVICE key, not by kp: kp is the root, and
	// roots are attested rather than delegated, so kp has no chain of its own.
	att, dd, device, err := identity.SelfHousehold(kp, identity.KindHuman, nil, "smoke", 1)
	if err != nil {
		log.Fatal(err)
	}
	kp = device
	for _, obj := range []any{att, dd} {
		blob, err := identity.Marshal(obj)
		if err != nil {
			log.Fatal(err)
		}
		if _, err := client.PutIdentityObject(ctx, connect.NewRequest(&cairnv1.PutIdentityObjectRequest{Cbor: blob})); err != nil {
			log.Fatalf("PutIdentityObject: %v", err)
		}
	}
	fmt.Printf("founded standalone household %x\n", kp.Pub)

	ev, err := event.Build(kp.Pub, kp.Priv, room, 1, nil, cairnv1.EventType_CHAT, []byte("hello from smoke"))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("built event %x\n", ev.EventId)

	sendResp, err := client.SendEvent(ctx, connect.NewRequest(&cairnv1.SendEventRequest{Event: ev}))
	if err != nil {
		log.Fatalf("SendEvent: %v", err)
	}
	fmt.Printf("server stored event %x\n", sendResp.Msg.GetEventId())

	// Sync from an empty frontier → should return our event.
	syncResp, err := client.Sync(ctx, connect.NewRequest(&cairnv1.SyncRequest{RoomId: room}))
	if err != nil {
		log.Fatalf("Sync: %v", err)
	}
	if len(syncResp.Msg.GetMissing()) != 1 {
		log.Fatalf("expected 1 event back, got %d", len(syncResp.Msg.GetMissing()))
	}
	got := syncResp.Msg.GetMissing()[0]
	if err := event.Verify(got); err != nil {
		log.Fatalf("round-tripped event failed verify: %v", err)
	}
	if string(got.EventId) != string(ev.EventId) {
		log.Fatal("event_id changed across the wire")
	}
	fmt.Printf("round-trip OK: verified event %x came back with %d heads\n",
		got.EventId, len(syncResp.Msg.GetHeads()))
	fmt.Println("PHASE 0 EXIT (server half): a signed Event round-trips proto ↔ Go ↔ server ✓")
}

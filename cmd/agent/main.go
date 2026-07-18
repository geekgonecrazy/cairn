// cmd/agent — a headless Cairn participant.
//
// Demonstrates that the protocol is genuinely client-agnostic: this is a plain
// Go program with an Ed25519 keypair, speaking the same signed events as the
// browser. It creates a room, admits a human by their member root, and posts
// declared inlays.
//
// It is NOT attested by anyone's household, so a browser will render it as an
// unverified key stub rather than a name. That is the correct outcome — being
// in a room means holding its key, which is a separate thing from being someone
// a household vouches for.
//
//	go run ./cmd/agent -member <64-hex member root> [-room kitchen] [-server http://localhost:8099]
//
// Keys (the agent's identity and the room keys it mints) go to
// $TMPDIR/cairn-agent by default — this is a test client and its key material
// is stored in the clear. Use -keys to put them somewhere deliberate.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"connectrpc.com/connect"

	"github.com/geekgonecrazy/cairn/approval"
	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
	"github.com/geekgonecrazy/cairn/proto/cairnv1/cairnv1connect"
	"github.com/geekgonecrazy/cairn/room"
)

// Declaration content addresses from the browser's standard library
// (webapp/src/lib/inlay/registry.ts). These are BLAKE3 over each declaration's
// deterministic CBOR, so they are stable identifiers a non-browser client can
// reference without shipping the declarations themselves.
const (
	cidPoll       = "b732d156878e8bb353ab31dd32b15be7de9da785ebff5da360f0702d875b7ede"
	cidTaskList   = "f78db9a8f5689f47101ca9f746fed25a024a67755f74f9aeb22640521db1b12a"
	cidAgentPanel = "b85178955252eda88350d00912c62b9ef0a37275ed9de0a790fadb62815aca22"
	cidGreenhouse = "0b552673e6e578a999d02a084428da614d2313018da4d898de7181f03a7c5a9c"
)

func main() {
	var (
		serverURL = flag.String("server", "http://localhost:8099", "cairnd base URL")
		memberHex = flag.String("member", "", "member root pubkey (64 hex) to admit to the room")
		roomName  = flag.String("room", "agent-demo", "room name to create")
		keyPath   = flag.String("keys", "", "where to persist the agent's own keys")
		watch     = flag.String("watch", "", "room id to watch for approval grants instead of posting")
	)
	flag.Parse()

	// Default to a temp directory, never $HOME. This is a demo/test client: it
	// writes an Ed25519 private key and PLAINTEXT room keys, and neither belongs
	// in a user's home directory by default. Pass -keys explicitly if you want
	// an identity that survives a reboot.
	if *keyPath == "" {
		dir := filepath.Join(os.TempDir(), "cairn-agent")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			log.Fatalf("agent: key dir: %v", err)
		}
		*keyPath = filepath.Join(dir, "agent.key")
	}

	me, err := loadOrCreateKey(*keyPath)
	if err != nil {
		log.Fatalf("agent: keys: %v", err)
	}
	fmt.Printf("agent member key: %s\n", hex.EncodeToString(me.Pub))

	client := cairnv1connect.NewCairnServiceClient(http.DefaultClient, *serverURL)
	ctx := context.Background()

	// Watch mode reads an existing room, so it needs no -member: that flag names
	// the human to ADMIT, which only applies when creating one.
	if *watch != "" {
		watchGrants(ctx, client, *watch, *keyPath)
		return
	}

	human, err := hex.DecodeString(*memberHex)
	if err != nil || len(human) != ed25519.PublicKeySize {
		log.Fatalf("agent: -member must be 64 hex chars (a member root pubkey); got %q", *memberHex)
	}

	// A room id must be unique on the carrier; rooms are not pre-seeded.
	roomID := fmt.Sprintf("%s-%s", *roomName, hex.EncodeToString(me.Pub[:3]))
	spaceID := "hh-agent-" + hex.EncodeToString(me.Pub[:6])

	send := func(ev *cairnv1.Event, what string) {
		if _, err := client.SendEvent(ctx, connect.NewRequest(&cairnv1.SendEventRequest{Event: ev})); err != nil {
			log.Fatalf("agent: send %s: %v", what, err)
		}
		log.Printf("sent %-18s %x", what, ev.EventId[:6])
	}

	// 1. Space + room. Both cleartext (epoch 0): a node that is not yet a member
	//    must be able to fold them.
	send(mustCleartext(me, spaceID, cairnv1.EventType_SPACE_CREATE, map[string]any{
		"space_name": "Agent demo", "admit_kind": "human,agent", "admit_origin": "any",
	}), "space_create")

	send(mustCleartext(me, roomID, cairnv1.EventType_ROOM_CREATE, map[string]any{
		"name": *roomName, "space_id": []byte(spaceID),
	}), "room_create")

	// 2. Mint the room key and admit both of us. The key is HPKE-wrapped to each
	//    MEMBER ROOT — the human can then decrypt on any device they pair.
	roomKey, err := room.NewRoomKey()
	if err != nil {
		log.Fatal(err)
	}
	const epoch = 1

	// Persist the room key. Without this the agent cannot read the room it just
	// created — including the answer to its own approval request, which makes
	// the whole request/grant loop pointless.
	if err := saveRoomKey(*keyPath, roomID, roomKey); err != nil {
		log.Fatalf("agent: save room key: %v", err)
	}

	wrapMe, err := room.WrapKey(me.Pub, roomKey)
	if err != nil {
		log.Fatal(err)
	}
	send(mustCleartext(me, roomID, cairnv1.EventType_MEMBER_ADD, map[string]any{
		"member_pub": []byte(me.Pub), "role": "admin", "epoch": epoch,
		"wrapped_keys": map[string][]byte{hex.EncodeToString(me.Pub): wrapMe},
	}), "member_add(self)")

	wrapHuman, err := room.WrapKey(human, roomKey)
	if err != nil {
		log.Fatal(err)
	}
	send(mustCleartext(me, roomID, cairnv1.EventType_MEMBER_ADD, map[string]any{
		"member_pub": human, "role": "member", "epoch": epoch,
		// Wrapped to BOTH: the newcomer needs the key, and existing members must
		// keep working across the epoch.
		"wrapped_keys": map[string][]byte{
			hex.EncodeToString(human): wrapHuman,
			hex.EncodeToString(me.Pub): wrapMe,
		},
	}), "member_add(human)")

	// 3. A chat line, so there is something ordinary alongside the inlays.
	send(mustSealed(me, roomID, roomKey, epoch, cairnv1.EventType_CHAT, map[string]any{
		"text": "Hello from cmd/agent — a headless Go client, not a browser.",
	}), "chat")

	// 4. A capability request — the human signs the grant in the UI, and the
	//    resulting artifact is portable: it verifies standalone, outside Cairn,
	//    with no room key. Cairn delivers and witnesses; it never mints.
	reqID := make([]byte, 16)
	if _, err := rand.Read(reqID); err != nil {
		log.Fatal(err)
	}
	capability := &approval.Capability{
		Name:   "vent.actuate",
		Params: map[string]string{"target": "gh_roof", "position": "open"},
		Scope:  "Open the greenhouse roof vent for 20 minutes",
	}
	areq, err := approval.NewRequest(
		reqID,
		identity.KeyPair{Pub: me.Pub, Priv: me.Priv},
		capability,
		time.Now().UnixMilli(),
		time.Now().Add(30*time.Minute).UnixMilli(),
	)
	if err != nil {
		log.Fatalf("agent: approval request: %v", err)
	}
	reqBytes, err := identity.Marshal(areq)
	if err != nil {
		log.Fatal(err)
	}
	send(mustSealedRaw(me, roomID, roomKey, epoch, cairnv1.EventType_APPROVAL_REQUEST, reqBytes),
		"approval_request")

	// 5. Declared inlays. Every one carries a text fallback: a client that cannot
	//    resolve the declaration must still render something truthful.
	for _, in := range inlays() {
		send(mustSealed(me, roomID, roomKey, epoch, cairnv1.EventType_INLAY, in.payload), in.what)
		time.Sleep(150 * time.Millisecond)
	}

	fmt.Printf("\nroom id:      %s\nagent member: %s\nhuman member: %s\n",
		roomID, hex.EncodeToString(me.Pub), *memberHex)
}

type inlay struct {
	what    string
	payload map[string]any
}

func inlays() []inlay {
	now := time.Now().UnixMilli()
	return []inlay{
		{"inlay(poll)", map[string]any{
			"decl_cid": cidPoll,
			"surface":  "timeline",
			"text":     "Poll: Ship the chain gate next? — yes (2), after QR (1), later (0).",
			"bindings": map[string]any{
				"question": "Ship the chain gate next?",
				"options": []any{
					map[string]any{"label": "Yes, enforce trustedRoots", "share": 0.66},
					map[string]any{"label": "After camera QR", "share": 0.34},
					map[string]any{"label": "Later", "share": 0.0},
				},
			},
		}},
		{"inlay(tasks)", map[string]any{
			"decl_cid": cidTaskList,
			"surface":  "timeline",
			"text":     "agent: 1 running, 1 queued, 2 done.",
			"bindings": map[string]any{
				"title":   "cmd/agent — task queue",
				"summary": map[string]any{"running": 1, "queued": 1, "done": 2},
				"tasks": []any{
					map[string]any{
						"name":     "Fold room state",
						"status":   map[string]any{"label": "running", "polarity": "busy"},
						"progress": 0.72,
					},
					map[string]any{
						"name":     "Enforce chain gate",
						"status":   map[string]any{"label": "queued", "polarity": "neutral"},
						"progress": 0.0,
					},
				},
			},
		}},
		{"inlay(agent_panel)", map[string]any{
			"decl_cid": cidAgentPanel,
			"surface":  "timeline",
			"text":     "cmd/agent — online. Capabilities: rooms.write (auto), keys.rotate (human-gated).",
			"bindings": map[string]any{
				"agent":   "cmd/agent",
				"status":  map[string]any{"label": "online", "polarity": "positive"},
				"title":   "cmd/agent — task queue",
				"summary": map[string]any{"running": 1, "queued": 1, "done": 2},
				"tasks": []any{
					map[string]any{
						"name":     "Fold room state",
						"status":   map[string]any{"label": "running", "polarity": "busy"},
						"progress": 0.72,
					},
				},
				"capabilities": []any{
					map[string]any{"name": "rooms.write", "policy": map[string]any{"label": "auto", "polarity": "positive"}},
					map[string]any{"name": "keys.rotate", "policy": map[string]any{"label": "human-gated", "polarity": "busy"}},
					map[string]any{"name": "device.revoke", "policy": map[string]any{"label": "forbidden", "polarity": "negative"}},
				},
			},
		}},
		// NOT in the standard library — exercises the per-room default-deny
		// allowlist. Expect the text fallback, not the card, until it is allowed.
		{"inlay(greenhouse, non-standard)", map[string]any{
			"decl_cid": cidGreenhouse,
			"surface":  "timeline",
			"text":     "Greenhouse east bench — 24.6°C, 61% humidity, soil 34%. Nominal.",
			"bindings": map[string]any{
				"title":      "Greenhouse — east bench",
				"updated_at": now,
				"status":     map[string]any{"label": "nominal", "polarity": "positive"},
				"air_temp":   map[string]any{"value": 24.6, "delta": 0.2, "trend": "up"},
				"humidity":   map[string]any{"value": 61, "delta": 1, "trend": "down"},
				"soil":       34,
				"co2":        640,
				"air_series": []any{23.1, 23.4, 23.2, 23.8, 24.2, 24.0, 24.5, 24.3, 24.6},
			},
		}},
	}
}

// --- event construction ----------------------------------------------------

type keypair struct {
	Pub  ed25519.PublicKey
	Priv ed25519.PrivateKey
}

// mustCleartext builds an epoch-0 (unencrypted) event — room-state events carry
// their own key material, so they must be readable by non-members.
func mustCleartext(me *keypair, roomID string, typ cairnv1.EventType, payload map[string]any) *cairnv1.Event {
	body, err := identity.Marshal(payload)
	if err != nil {
		log.Fatal(err)
	}
	framed := append([]byte{0x00}, body...) // uvarint(0) || cbor
	return mustSign(me, roomID, typ, framed)
}

// mustSealedRaw seals an already-encoded CBOR payload (an approval artifact is
// signed over its own canonical bytes, so it must not be re-encoded here).
func mustSealedRaw(me *keypair, roomID string, key []byte, epoch uint64, typ cairnv1.EventType, body []byte) *cairnv1.Event {
	ts := time.Now().UnixMilli()
	sealed, err := room.Seal(key, epoch, me.Pub, []byte(roomID), ts, typ, body)
	if err != nil {
		log.Fatal(err)
	}
	return mustSignAt(me, roomID, typ, sealed, ts)
}

// mustSealed builds a room-encrypted event.
func mustSealed(me *keypair, roomID string, key []byte, epoch uint64, typ cairnv1.EventType, payload map[string]any) *cairnv1.Event {
	body, err := identity.Marshal(payload)
	if err != nil {
		log.Fatal(err)
	}
	ts := time.Now().UnixMilli()
	sealed, err := room.Seal(key, epoch, me.Pub, []byte(roomID), ts, typ, body)
	if err != nil {
		log.Fatal(err)
	}
	return mustSignAt(me, roomID, typ, sealed, ts)
}

func mustSign(me *keypair, roomID string, typ cairnv1.EventType, payload []byte) *cairnv1.Event {
	return mustSignAt(me, roomID, typ, payload, time.Now().UnixMilli())
}

func mustSignAt(me *keypair, roomID string, typ cairnv1.EventType, payload []byte, ts int64) *cairnv1.Event {
	// No parents: this agent creates a fresh room, so its first events are roots
	// and later ones converge by the DAG's merge rule rather than a chain we track.
	ev, err := event.Build(me.Pub, me.Priv, []byte(roomID), ts, nil, typ, payload)
	if err != nil {
		log.Fatalf("agent: build: %v", err)
	}
	return ev
}

func loadOrCreateKey(path string) (*keypair, error) {
	if b, err := os.ReadFile(path); err == nil && len(b) == ed25519.PrivateKeySize {
		priv := ed25519.PrivateKey(b)
		return &keypair{Pub: priv.Public().(ed25519.PublicKey), Priv: priv}, nil
	}
	kp, err := identity.GenerateKey()
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, kp.Priv, 0o600); err != nil {
		return nil, err
	}
	return &keypair{Pub: kp.Pub, Priv: kp.Priv}, nil
}


// --- watching for grants ---------------------------------------------------

// watchGrants pulls the room's history and verifies any approval_grant found.
//
// The grant is extracted from a room-encrypted event, but the VERIFICATION uses
// only the artifact's own bytes — no room key, no household, no server. That is
// the point of a portable grant: whoever ends up holding it (here, an agent; in
// production, an external broker) can check it standalone.
func watchGrants(ctx context.Context, client cairnv1connect.CairnServiceClient, roomID, keyPath string) {
	key, err := loadRoomKey(keyPath, roomID)
	if err != nil {
		log.Fatalf("agent: no stored key for room %q: %v", roomID, err)
	}

	res, err := client.Sync(ctx, connect.NewRequest(&cairnv1.SyncRequest{RoomId: []byte(roomID)}))
	if err != nil {
		log.Fatalf("agent: sync: %v", err)
	}

	requests := map[string]*approval.Request{}
	found := 0
	for _, ev := range res.Msg.GetMissing() {
		switch ev.Type {
		case cairnv1.EventType_APPROVAL_REQUEST:
			_, body, err := room.Open(key, ev)
			if err != nil {
				continue
			}
			var r approval.Request
			if identity.Unmarshal(body, &r) == nil {
				requests[hex.EncodeToString(r.RequestID)] = &r
			}
		case cairnv1.EventType_APPROVAL_DENY:
			_, body, err := room.Open(key, ev)
			if err != nil {
				log.Printf("deny found but undecryptable: %v", err)
				continue
			}
			var d approval.Deny
			if err := identity.Unmarshal(body, &d); err != nil {
				log.Printf("deny found but undecodable: %v", err)
				continue
			}
			found++
			reportDeny(&d, requests[hex.EncodeToString(d.RequestID)])

		case cairnv1.EventType_APPROVAL_GRANT:
			_, body, err := room.Open(key, ev)
			if err != nil {
				log.Printf("grant found but undecryptable: %v", err)
				continue
			}
			var g approval.Grant
			if err := identity.Unmarshal(body, &g); err != nil {
				log.Printf("grant found but undecodable: %v", err)
				continue
			}
			found++
			reportGrant(&g, requests[hex.EncodeToString(g.RequestID)])
		}
	}
	if found == 0 {
		fmt.Println("no approval decisions in this room yet")
	}
}

// reportDeny verifies a refusal. A deny is a SIGNED ARTIFACT, not an absence:
// the difference between "they said no" and "we never heard back" is exactly
// what an agent must not have to guess. Timeout-driven denial is the absence of
// either artifact before expiry.
func reportDeny(d *approval.Deny, req *approval.Request) {
	fmt.Printf("\n--- approval_deny ---\n")
	fmt.Printf("request_id      %x\n", d.RequestID)
	fmt.Printf("approver_pub    %x\n", d.ApproverPub)
	if d.Reason != "" {
		fmt.Printf("reason          %q\n", d.Reason)
	}
	if err := approval.VerifyDeny(d); err != nil {
		fmt.Printf("SIGNATURE       INVALID: %v\n", err)
		return
	}
	fmt.Printf("SIGNATURE       valid (checked standalone, no room key)\n")
	if req != nil {
		fmt.Printf("REFUSED         %s (%s)\n", req.Capability.Name, req.Capability.Scope)
	} else {
		fmt.Printf("REFUSED         request not seen — cannot say what was refused\n")
	}
	fmt.Printf("ACTION          do NOT proceed; this is a signed refusal, not a timeout\n")
}

func reportGrant(g *approval.Grant, req *approval.Request) {
	fmt.Printf("\n--- approval_grant ---\n")
	fmt.Printf("request_id      %x\n", g.RequestID)
	fmt.Printf("approver_pub    %x\n", g.ApproverPub)
	fmt.Printf("agent_pub       %x\n", g.AgentPub)
	fmt.Printf("capability_hash %x\n", g.CapabilityHash)
	fmt.Printf("expires_at      %s\n", time.UnixMilli(g.ExpiresAt).Format(time.RFC3339))

	// 1. Standalone signature check — no room key, no household, no server.
	if err := approval.VerifyGrant(g); err != nil {
		fmt.Printf("SIGNATURE       INVALID: %v\n", err)
		return
	}
	fmt.Printf("SIGNATURE       valid (checked standalone, no room key)\n")

	// 2. Expiry.
	if g.Expired(time.Now().UnixMilli()) {
		fmt.Printf("EXPIRY          EXPIRED\n")
	} else {
		fmt.Printf("EXPIRY          live\n")
	}

	// 3. Binding: the grant must match the capability that was actually asked
	//    for, and name THIS agent. Without both checks a valid signature could
	//    be replayed for a different action or by a different agent.
	if req == nil {
		fmt.Printf("BINDING         request not seen — cannot confirm what was approved\n")
		return
	}
	capHash, err := approval.HashCapability(req.Capability)
	if err != nil {
		fmt.Printf("BINDING         cannot hash capability: %v\n", err)
		return
	}
	switch {
	case !bytes.Equal(g.CapabilityHash, capHash[:]):
		fmt.Printf("BINDING         MISMATCH — grant is not for the capability requested\n")
	case !bytes.Equal(g.AgentPub, req.AgentPub):
		fmt.Printf("BINDING         MISMATCH — grant names a different agent\n")
	default:
		fmt.Printf("BINDING         ok — %s (%s)\n", req.Capability.Name, req.Capability.Scope)
	}
}

// --- room key storage ------------------------------------------------------

func roomKeyFile(keyPath, roomID string) string {
	return keyPath + ".room." + hex.EncodeToString([]byte(roomID))
}

func saveRoomKey(keyPath, roomID string, key []byte) error {
	return os.WriteFile(roomKeyFile(keyPath, roomID), key, 0o600)
}

func loadRoomKey(keyPath, roomID string) ([]byte, error) {
	return os.ReadFile(roomKeyFile(keyPath, roomID))
}

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

// declaration is an inlay declaration this agent DEFINES and publishes.
//
// These used to be hashes copied from the browser's standard library, which
// meant the agent could only reference UI the client already shipped. It now
// defines its own and publishes them as INLAY_DECL events, which is the point:
// an agent composes whatever UI its job needs, and the client learns it from
// the event. Nothing here is special-cased in any renderer.
type declaration struct {
	decl map[string]any
	cid  string
}

// declare computes the declaration's content address the same way every client
// does — BLAKE3 over its deterministic CBOR. Deriving it rather than hardcoding
// it is what keeps the cid honest when the declaration is edited.
func declare(decl map[string]any) declaration {
	sum, err := identity.Hash(decl)
	if err != nil {
		log.Fatalf("agent: hash declaration %v: %v", decl["name"], err)
	}
	return declaration{decl: decl, cid: hex.EncodeToString(sum[:])}
}

// The examples this agent ships. Moved out of the webapp: a card only the client
// could render was proving the renderer, not the protocol.
var (
	declPoll = declare(map[string]any{
		"name":       "poll",
		"version":    1,
		"authorless": true,
		"schema": map[string]any{
			"role":   "group",
			"header": map[string]any{"role": "text", "bind": "question", "emphasis": "title"},
			"children": []any{
				map[string]any{
					"role": "list", "bind": "options", "empty": "No options.",
					"item": map[string]any{
						"role": "group",
						"children": []any{
							map[string]any{"role": "text", "bind": "label"},
							map[string]any{"role": "progress_fraction", "bind": "share", "polarity": "neutral"},
						},
					},
				},
			},
		},
		"actions": []any{map[string]any{"id": "vote", "label": "Vote", "kind": "immediate", "variant": "primary"}},
	})

	declTaskList = declare(map[string]any{
		"name":         "task_list",
		"version":      1,
		"bound_events": []any{"task_request", "task_update"},
		"schema": map[string]any{
			"role":   "group",
			"header": map[string]any{"role": "text", "bind": "title", "emphasis": "title"},
			"children": []any{
				map[string]any{
					"role": "record", "cols": 3,
					"fields": []any{
						map[string]any{"key": "Running", "node": map[string]any{"role": "number", "bind": "summary.running"}},
						map[string]any{"key": "Queued", "node": map[string]any{"role": "number", "bind": "summary.queued"}},
						map[string]any{"key": "Done today", "node": map[string]any{"role": "number", "bind": "summary.done"}},
					},
				},
				map[string]any{
					"role": "list", "bind": "tasks", "empty": "Nothing queued.",
					"item": map[string]any{
						"role": "group",
						"children": []any{
							map[string]any{"role": "text", "bind": "name"},
							map[string]any{"role": "status_enum", "bind": "status"},
							map[string]any{"role": "progress_fraction", "bind": "progress"},
						},
					},
				},
			},
		},
		"actions": []any{map[string]any{"id": "add_task", "label": "Add task", "kind": "modal", "variant": "primary"}},
	})

	// Composition by hash: a panel embeds the task list via inlay_ref, so the
	// agent must publish BOTH declarations or the panel renders with a hole.
	declAgentPanel = declare(map[string]any{
		"name":    "agent_panel",
		"version": 1,
		"schema": map[string]any{
			"role":   "group",
			"header": map[string]any{"role": "text", "bind": "agent", "emphasis": "title"},
			"children": []any{
				map[string]any{"role": "status_enum", "bind": "status"},
				map[string]any{"role": "inlay_ref", "decl_cid": declTaskList.cid},
				map[string]any{
					"role":   "group",
					"header": map[string]any{"role": "text", "value": "Capabilities", "emphasis": "note"},
					"children": []any{
						map[string]any{
							"role": "list", "bind": "capabilities", "empty": "No capabilities granted.",
							"item": map[string]any{
								"role": "group",
								"children": []any{
									map[string]any{"role": "text", "bind": "name"},
									map[string]any{"role": "status_enum", "bind": "policy"},
								},
							},
						},
					},
				},
			},
		},
		"actions": []any{
			map[string]any{"id": "configure", "label": "Configure", "kind": "modal"},
			map[string]any{"id": "logs", "label": "Logs", "kind": "immediate", "variant": "ghost"},
		},
	})

	// A PANEL declaration: the agent's standing status, pinned beside the room
	// rather than posted into it. Panels are for what is CURRENTLY true; the
	// timeline is for what happened.
	declAgentStatus = declare(map[string]any{
		"name":    "agent_status",
		"version": 1,
		"schema": map[string]any{
			"role":   "group",
			"header": map[string]any{"role": "text", "bind": "agent", "emphasis": "title"},
			"children": []any{
				map[string]any{"role": "status_enum", "bind": "status"},
				map[string]any{"role": "text", "bind": "doing", "emphasis": "note"},
				map[string]any{
					"role": "record", "cols": 2,
					"fields": []any{
						map[string]any{"key": "Queue", "node": map[string]any{"role": "number", "bind": "queued"}},
						map[string]any{"key": "Done today", "node": map[string]any{"role": "number", "bind": "done"}},
					},
				},
				map[string]any{
					"role":   "group",
					"header": map[string]any{"role": "text", "value": "Capabilities", "emphasis": "note"},
					"children": []any{
						map[string]any{
							"role": "list", "bind": "capabilities", "empty": "No capabilities granted.",
							"item": map[string]any{
								"role": "group",
								"children": []any{
									map[string]any{"role": "text", "bind": "name"},
									map[string]any{"role": "status_enum", "bind": "policy"},
								},
							},
						},
					},
				},
			},
		},
		"actions": []any{map[string]any{"id": "logs", "label": "Logs", "kind": "immediate", "variant": "ghost"}},
	})

	// The live job card: posted once, then repainted by inlay_update checkpoints
	// as the work proceeds. Progress is a BINDING, not a new message — the room
	// gets one card that changes, instead of a scroll of status lines.
	declJob = declare(map[string]any{
		"name":    "agent_job",
		"version": 1,
		"schema": map[string]any{
			"role":   "group",
			"header": map[string]any{"role": "text", "bind": "title", "emphasis": "title"},
			"children": []any{
				map[string]any{"role": "status_enum", "bind": "status"},
				map[string]any{"role": "progress_fraction", "bind": "progress", "label": "Progress"},
				map[string]any{"role": "text", "bind": "step", "emphasis": "note"},
				map[string]any{
					"role": "record", "cols": 2,
					"fields": []any{
						map[string]any{"key": "Files", "node": map[string]any{"role": "number", "bind": "files"}},
						map[string]any{"key": "Elapsed", "node": map[string]any{"role": "number", "bind": "elapsed", "unit": "s"}},
					},
				},
			},
		},
		"actions": []any{map[string]any{"id": "cancel", "label": "Cancel", "kind": "immediate", "variant": "danger"}},
	})

	declGreenhouse = declare(map[string]any{
		"name":    "greenhouse_bench",
		"version": 1,
		"schema": map[string]any{
			"role":   "group",
			"header": map[string]any{"role": "text", "bind": "title", "emphasis": "title"},
			"children": []any{
				map[string]any{"role": "timestamp", "bind": "updated_at"},
				map[string]any{"role": "status_enum", "bind": "status"},
				map[string]any{
					"role": "record", "cols": 2,
					"fields": []any{
						map[string]any{"key": "Air temp", "node": map[string]any{"role": "number", "bind": "air_temp", "unit": "°C", "showTrend": true}, "note": "within 22–26° band"},
						map[string]any{"key": "Humidity", "node": map[string]any{"role": "number", "bind": "humidity", "unit": "%", "showTrend": true}, "note": "target 55–70%"},
						map[string]any{"key": "Soil moisture", "node": map[string]any{"role": "number", "bind": "soil", "unit": "%"}, "note": "beds nominal"},
						map[string]any{"key": "CO₂", "node": map[string]any{"role": "number", "bind": "co2", "unit": "ppm"}, "note": "day cycle"},
					},
				},
				map[string]any{"role": "series", "bind": "air_series", "polarity": "positive", "band": []any{22, 26}, "label": "Air temp · last 6h"},
			},
		},
		"actions": []any{
			map[string]any{"id": "refresh", "label": "Refresh", "kind": "immediate", "variant": "ghost"},
			map[string]any{"id": "vent", "label": "Open roof vent", "kind": "immediate",
				"capability_request": "vent.actuate(gh_roof)", "scope": "30 min · this vent only"},
		},
	})
)

func main() {
	var (
		serverURL = flag.String("server", "http://localhost:8099", "cairnd base URL")
		memberHex = flag.String("member", "", "member root pubkey (64 hex) to admit to the room")
		roomName  = flag.String("room", "agent-demo", "room name to create")
		keyPath   = flag.String("keys", "", "where to persist the agent's own keys")
		watch     = flag.String("watch", "", "room id to watch for approval grants instead of posting")
		invite    = flag.String("invite", "", "the cairn:att:… invite from `cairnctl attest -kind agent`")
		name      = flag.String("name", "cmd/agent", "display name to request when joining")
		live      = flag.Bool("live", false,
			"after posting, wait for the approval to be granted, then post a job card and update it")
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

	// Asking to join needs nothing but this agent's own key, so the join code is
	// printed before -member is required. Demanding the operator's member root to
	// show a join code would be a chicken-and-egg the operator cannot solve.
	storedAtt, err := loadAttestation(*keyPath)
	if err != nil {
		log.Fatalf("agent: attestation: %v", err)
	}
	if storedAtt == nil && *invite == "" {
		printJoinInstructions(me.Pub, *name)
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

	// 0. Establish identity — as a member of the OPERATOR'S household, not a
	//    household of its own.
	//
	//    The agent generates and keeps its own private key; it never sees the
	//    recovery phrase. It shows a join code, the operator attests it with
	//    `cairnctl attest -kind agent -operated-by <their member root>`, and the
	//    resulting invite is stored beside the key. From then on the agent chains
	//    to the same root as everyone else, so the carrier accepts it with no
	//    second root pinned and the humans see an attested name rather than a
	//    key stub.
	//
	//    Events are signed by the DERIVED DEVICE key, not the member root: roots
	//    are attested rather than delegated, so a root has no chain of its own.
	//    The device key is derived from the stored key, so it is stable across
	//    runs — a random one would lose every room key wrapped to the previous
	//    device.
	att := storedAtt
	if att == nil {
		att, err = identity.ParseInvite(*invite)
		if err != nil {
			log.Fatalf("agent: -invite: %v", err)
		}
		if !bytes.Equal(att.Pubkey, me.Pub) {
			log.Fatalf("agent: that invite attests %x, but this agent's member key is %x.\n"+
				"An invite is bound to the key that asked for it; attest THIS agent's join code.",
				att.Pubkey[:6], me.Pub[:6])
		}
		if !identity.VerifyAttestation(att) {
			log.Fatal("agent: that invite does not verify against its own origin")
		}
		if err := saveAttestation(*keyPath, att); err != nil {
			log.Fatalf("agent: save attestation: %v", err)
		}
		log.Printf("attested into household %x as %q", att.Origin[:6], att.DisplayName)
	}

	memberRoot := append([]byte(nil), me.Pub...)
	// Same derivation the standalone path used: stable across runs, so room keys
	// wrapped to this device keep opening.
	device, err := identity.StandaloneDeviceKey(identity.KeyPair{Pub: me.Pub, Priv: me.Priv})
	if err != nil {
		log.Fatalf("agent: derive device key: %v", err)
	}
	req, err := identity.NewPairingRequest(device.Pub, "cmd/agent")
	if err != nil {
		log.Fatal(err)
	}
	now := time.Now()
	dd, err := identity.ApprovePairing(req, memberRoot, me.Priv,
		now.UnixMilli(), now.Add(365*24*time.Hour).UnixMilli())
	if err != nil {
		log.Fatalf("agent: device delegation: %v", err)
	}
	me.Pub, me.Priv = device.Pub, device.Priv

	for _, obj := range []any{att, dd} {
		blob, err := identity.Marshal(obj)
		if err != nil {
			log.Fatal(err)
		}
		if _, err := client.PutIdentityObject(ctx, connect.NewRequest(&cairnv1.PutIdentityObjectRequest{Cbor: blob})); err != nil {
			log.Fatalf("agent: publish identity: %v", err)
		}
	}
	log.Printf("identity published: member %x, device %x, operated by %x",
		memberRoot[:6], me.Pub[:6], att.OperatedBy[:min(6, len(att.OperatedBy))])

	// 1. Space + room. Both cleartext (epoch 0): a node that is not yet a member
	//    must be able to fold them.
	send(mustCleartext(me, spaceID, cairnv1.EventType_SPACE_CREATE, map[string]any{
		"space_name": "Agent demo", "admit_kind": "human,agent", "admit_origin": "any",
	}), "space_create")

	// The SPACE roster is the authority: a client enforces "channel roster ⊆
	// space roster" and evicts anyone in a channel who is not a space member,
	// rotating the key without them (webapp drainRoom). Creating a space without
	// joining it therefore got this agent thrown out of its OWN room by the first
	// human to open it — a MEMBER_REMOVE plus a rotation it could not read, which
	// looked from here like nobody ever answering the approval request.
	for _, m := range []struct {
		pub  []byte
		role string
		what string
	}{{memberRoot, "admin", "space_member_add(self)"}, {human, "admin", "space_member_add(human)"}} {
		send(mustCleartext(me, spaceID, cairnv1.EventType_SPACE_MEMBER_ADD, map[string]any{
			"member_pub": m.pub, "role": m.role,
		}), m.what)
	}

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
	// member_pub is the MEMBER ROOT; wrapped_keys are addressed to DEVICES. Using
	// the device key for both looked harmless — the agent could still open its own
	// room — but it puts a device key where every other reader expects a member
	// root. The roster then disagrees with the identity chain, so anything that
	// resolves a sender to its member and looks it up in the roster fails: the
	// agent's own published declarations were refused as if a stranger had sent
	// them.
	send(mustCleartext(me, roomID, cairnv1.EventType_MEMBER_ADD, map[string]any{
		"member_pub": memberRoot, "role": "admin", "epoch": epoch,
		"wrapped_keys": map[string][]byte{hex.EncodeToString(me.Pub): wrapMe},
	}), "member_add(self)")

	// Room keys wrap to DEVICE keys, not member roots — a member root is offline
	// and holds no secret to unwrap with. So admitting the human means sealing to
	// every device in their tree, which the carrier resolves for us.
	humanDevices, err := client.ListMemberDevices(ctx,
		connect.NewRequest(&cairnv1.ListMemberDevicesRequest{MemberPub: human}))
	if err != nil {
		log.Fatalf("agent: list human devices: %v", err)
	}
	if len(humanDevices.Msg.GetDevicePubs()) == 0 {
		log.Fatalf("agent: the human %x has no published devices on this carrier — "+
			"open the webapp there once so its device delegation is published, then re-run. "+
			"Wrapping to their member root would produce a key nobody can open.", human[:6])
	}
	// Wrapped to the newcomer's devices AND our own: existing members must keep
	// working across the epoch.
	wrapped := map[string][]byte{hex.EncodeToString(me.Pub): wrapMe}
	for _, dev := range humanDevices.Msg.GetDevicePubs() {
		w, err := room.WrapKey(dev, roomKey)
		if err != nil {
			log.Fatal(err)
		}
		wrapped[hex.EncodeToString(dev)] = w
	}
	send(mustCleartext(me, roomID, cairnv1.EventType_MEMBER_ADD, map[string]any{
		"member_pub": human, "role": "member", "epoch": epoch,
		"wrapped_keys": wrapped,
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
	areq, err := approval.NewCapabilityRequest(
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

	// 5. Publish the DECLARATIONS first, then instances of them.
	//
	//    Order matters only for how it looks on arrival, not for correctness: an
	//    instance whose declaration has not landed yet degrades to its text line
	//    and renders once the declaration syncs. Sending declarations first just
	//    means the room looks right the first time.
	for _, d := range []declaration{declPoll, declTaskList, declAgentPanel, declGreenhouse, declAgentStatus} {
		send(mustSealed(me, roomID, roomKey, epoch, cairnv1.EventType_INLAY_DECL,
			map[string]any{"decl": d.decl}), fmt.Sprintf("inlay_decl(%s) %s", d.decl["name"], d.cid[:8]))
		time.Sleep(100 * time.Millisecond)
	}

	// 6. Declared inlays. Every one carries a text fallback: a client that cannot
	//    resolve the declaration must still render something truthful.
	for _, in := range inlays() {
		send(mustSealed(me, roomID, roomKey, epoch, cairnv1.EventType_INLAY, in.payload), in.what)
		time.Sleep(150 * time.Millisecond)
	}

	// 6b. The standing panel. surface: "room_panel" keeps it out of the timeline
	//     and pins it beside the room, where "what is this agent doing right now"
	//     belongs.
	panelCard := mustSealed(me, roomID, roomKey, epoch, cairnv1.EventType_INLAY, map[string]any{
		"decl_cid": declAgentStatus.cid,
		"surface":  "room_panel",
		"text":     "Greenhouse Agent — idle. Capabilities: vent.actuate (human-gated).",
		"bindings": map[string]any{
			"agent":  "Greenhouse Agent",
			"status": map[string]any{"label": "idle", "polarity": "neutral"},
			"doing":  "Waiting for something to do",
			"queued": 0,
			"done":   2,
			"capabilities": []any{
				map[string]any{"name": "vent.actuate", "policy": map[string]any{"label": "human-gated", "polarity": "busy"}},
				map[string]any{"name": "rooms.write", "policy": map[string]any{"label": "auto", "polarity": "positive"}},
			},
		},
	})
	send(panelCard, "inlay(agent_status, room_panel)")

	// 7. The live job: ask for approval, wait for a human to grant it, then post
	//    ONE card and keep it current with inlay_update checkpoints.
	if *live {
		runLiveJob(ctx, client, send, me, roomID, roomKey, epoch, areq.RequestID, panelCard.EventId)
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
			"decl_cid": declPoll.cid,
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
			"decl_cid": declTaskList.cid,
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
			"decl_cid": declAgentPanel.cid,
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
		// Published by this agent like the rest. Under trust-by-author it renders
		// for anyone who has the agent in their room; a client that never receives
		// the declaration shows the text line instead.
		{"inlay(greenhouse, non-standard)", map[string]any{
			"decl_cid": declGreenhouse.cid,
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


// attestationPath keeps the invite beside the key: the two together are the
// agent's whole identity, and splitting them across directories is how a working
// agent turns into an unattested stranger after a move.
func attestationPath(keyPath string) string { return keyPath + ".att" }

func loadAttestation(keyPath string) (*identity.IdentityAttestation, error) {
	b, err := os.ReadFile(attestationPath(keyPath))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var att identity.IdentityAttestation
	if err := identity.Unmarshal(b, &att); err != nil {
		return nil, fmt.Errorf("stored attestation is unreadable: %w", err)
	}
	if !identity.VerifyAttestation(&att) {
		return nil, fmt.Errorf("stored attestation does not verify")
	}
	return &att, nil
}

func saveAttestation(keyPath string, att *identity.IdentityAttestation) error {
	blob, err := identity.Marshal(att)
	if err != nil {
		return err
	}
	return os.WriteFile(attestationPath(keyPath), blob, 0o600)
}

// printJoinInstructions shows the join code and the exact command to attest it.
//
// The agent asks to join the same way a person does. That symmetry is the point:
// there is no separate "agent enrolment" mechanism to reason about, and the
// operator sees a name and fingerprint before vouching for anything.
func printJoinInstructions(memberPub ed25519.PublicKey, name string) {
	req, err := identity.NewJoinRequest(memberPub, name)
	if err != nil {
		log.Fatalf("agent: join request: %v", err)
	}
	fmt.Printf(`
This agent has no attestation yet, so the carrier would refuse everything it
sends. It holds its own private key and never needs the household phrase.

  1. Attest it (as the operator, with your own member root):

     go run ./cmd/cairnctl attest -kind agent -operated-by <your-member-root-hex> \
       %q

  2. Re-run the agent with the invite it prints:

     go run ./cmd/agent -invite "cairn:att:…" -member <your-member-root-hex>

  member key:  %s
  fingerprint: %s

`, req.Encode(), hex.EncodeToString(memberPub), identity.Fingerprint(memberPub))
}

// runLiveJob waits for a human decision, then does visible work.
//
// This is the shape an agent's UI is supposed to take: ask before acting, and
// once permitted, keep ONE card honest rather than narrating into the timeline.
// The progress a human sees is the agent's actual state, published as
// checkpoints against the card it already posted.
func runLiveJob(
	ctx context.Context,
	client cairnv1connect.CairnServiceClient,
	send func(*cairnv1.Event, string),
	me *keypair,
	roomID string,
	roomKey []byte,
	epoch uint64,
	requestID []byte,
	panelID []byte,
) {
	log.Printf("waiting for a human to approve %x …", requestID[:6])
	roomKey, epoch, granted := waitForGrant(ctx, client, roomID, roomKey, epoch, me, requestID, 10*time.Minute)
	if !granted {
		log.Printf("no grant arrived; the job stays unstarted, which is the correct outcome")
		return
	}
	log.Printf("approved — starting the job")

	send(mustSealed(me, roomID, roomKey, epoch, cairnv1.EventType_INLAY_DECL,
		map[string]any{"decl": declJob.decl}), "inlay_decl(agent_job)")

	started := time.Now()
	card := mustSealed(me, roomID, roomKey, epoch, cairnv1.EventType_INLAY, map[string]any{
		"decl_cid": declJob.cid,
		"surface":  "timeline",
		"text":     "Indexing the greenhouse archive — starting.",
		"bindings": map[string]any{
			"title":    "Indexing the greenhouse archive",
			"status":   map[string]any{"label": "starting", "polarity": "busy"},
			"progress": 0.0,
			"step":     "Waiting for the first batch",
			"files":    0,
			"elapsed":  0,
		},
	})
	send(card, "inlay(agent_job)")

	// Checkpoints against the card's event_id. Each carries only what changed;
	// the client merges it over the bindings already on screen.
	steps := []struct {
		progress float64
		step     string
		files    int
		status   string
		polarity string
	}{
		{0.18, "Reading bench sensor logs", 214, "running", "busy"},
		{0.41, "Normalising timestamps", 508, "running", "busy"},
		{0.66, "Building the search index", 812, "running", "busy"},
		{0.88, "Verifying checksums", 1043, "running", "busy"},
		{1.0, "Done — 1,120 files indexed", 1120, "complete", "positive"},
	}
	for _, st := range steps {
		time.Sleep(12 * time.Second)
		send(mustSealed(me, roomID, roomKey, epoch, cairnv1.EventType_INLAY_UPDATE, map[string]any{
			"target": panelID,
			"state": map[string]any{
				"status": map[string]any{"label": st.status, "polarity": st.polarity},
				"doing":  st.step,
				"queued": 1,
			},
		}), "inlay_update(panel)")
		send(mustSealed(me, roomID, roomKey, epoch, cairnv1.EventType_INLAY_UPDATE, map[string]any{
			"target": card.EventId,
			"state": map[string]any{
				"progress": st.progress,
				"step":     st.step,
				"files":    st.files,
				"status":   map[string]any{"label": st.status, "polarity": st.polarity},
				"elapsed":  int(time.Since(started).Seconds()),
			},
		}), fmt.Sprintf("inlay_update(%.0f%%)", st.progress*100))
	}
	// Leave the panel truthful once the work stops: a standing card that still
	// says "running" after the job ended is worse than no card.
	send(mustSealed(me, roomID, roomKey, epoch, cairnv1.EventType_INLAY_UPDATE, map[string]any{
		"target": panelID,
		"state": map[string]any{
			"status": map[string]any{"label": "idle", "polarity": "neutral"},
			"doing":  "Waiting for something to do",
			"queued": 0,
			"done":   3,
		},
	}), "inlay_update(panel idle)")
	log.Printf("job complete")
}

// adoptLatestKey follows room-key rotations.
//
// An agent is a participant, not a publisher: the humans in its room rotate keys
// (adding a member, pairing a device, or just re-wrapping after onboarding), and
// every rotation mints a NEW epoch. An agent that keeps using the key it minted
// reads nothing sent afterwards — including the approval it is waiting for — and
// the failure looks exactly like nobody having answered. That is the bug this
// function exists to prevent, and it is why the demo appeared to hang.
//
// Returns the highest-epoch key this agent can unwrap, or the current one.
func adoptLatestKey(events []*cairnv1.Event, devicePriv ed25519.PrivateKey, devicePub ed25519.PublicKey,
	curKey []byte, curEpoch uint64) ([]byte, uint64) {
	bestKey, bestEpoch := curKey, curEpoch
	for _, ev := range events {
		if ev.Type != cairnv1.EventType_MEMBER_ADD && ev.Type != cairnv1.EventType_ROOM_KEY_ROTATE {
			continue
		}
		// Room-state events are cleartext at epoch 0: one frame byte, then CBOR.
		if len(ev.Payload) < 1 {
			continue
		}
		var body struct {
			Epoch       uint64            `cbor:"epoch"`
			WrappedKeys map[string][]byte `cbor:"wrapped_keys"`
		}
		if err := identity.Unmarshal(ev.Payload[1:], &body); err != nil {
			continue
		}
		if body.Epoch <= bestEpoch {
			continue
		}
		blob, ok := body.WrappedKeys[hex.EncodeToString(devicePub)]
		if !ok {
			continue // rotated, but not wrapped to this device
		}
		key, err := room.UnwrapKey(devicePriv, blob)
		if err != nil {
			continue
		}
		bestKey, bestEpoch = key, body.Epoch
	}
	return bestKey, bestEpoch
}

// waitForGrant polls the room until the named request is granted, or the
// deadline passes. Polling rather than SSE keeps this demo to one transport.
func waitForGrant(
	ctx context.Context,
	client cairnv1connect.CairnServiceClient,
	roomID string,
	roomKey []byte,
	epoch uint64,
	me *keypair,
	requestID []byte,
	within time.Duration,
) ([]byte, uint64, bool) {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		res, err := client.Sync(ctx, connect.NewRequest(&cairnv1.SyncRequest{RoomId: []byte(roomID)}))
		if err == nil {
			// Take any newer key first: the grant we are waiting for is very
			// likely sealed under it.
			if k, e := adoptLatestKey(res.Msg.GetMissing(), me.Priv, me.Pub, roomKey, epoch); e > epoch {
				log.Printf("adopted room key epoch %d (was %d)", e, epoch)
				roomKey, epoch = k, e
			}
			for _, ev := range res.Msg.GetMissing() {
				if ev.Type != cairnv1.EventType_APPROVAL_GRANT {
					continue
				}
				_, body, err := room.Open(roomKey, ev)
				if err != nil {
					continue
				}
				var g approval.Grant
				if identity.Unmarshal(body, &g) != nil {
					continue
				}
				if bytes.Equal(g.RequestID, requestID) {
					return roomKey, epoch, true
				}
			}
		}
		time.Sleep(3 * time.Second)
	}
	return roomKey, epoch, false
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
		name, scope := describeCapability(req)
		fmt.Printf("REFUSED         %s (%s)\n", name, scope)
	} else {
		fmt.Printf("REFUSED         request not seen — cannot say what was refused\n")
	}
	fmt.Printf("ACTION          do NOT proceed; this is a signed refusal, not a timeout\n")
}

// describeCapability renders a request's payload for the human-readable log. It
// decodes the standard capability payload; for any other payload_type it falls
// back to the type tag rather than pretending it understands the bytes.
func describeCapability(req *approval.Request) (name, scope string) {
	cap, err := approval.UnmarshalCapability(req.PayloadType, req.Payload)
	if err != nil {
		return req.PayloadType, ""
	}
	return cap.Name, cap.Scope
}

func reportGrant(g *approval.Grant, req *approval.Request) {
	fmt.Printf("\n--- approval_grant ---\n")
	fmt.Printf("request_id      %x\n", g.RequestID)
	fmt.Printf("approver_pub    %x\n", g.ApproverPub)
	fmt.Printf("agent_pub       %x\n", g.AgentPub)
	fmt.Printf("payload_hash    %x\n", g.PayloadHash)
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
	payHash := approval.HashPayload(req.Payload)
	name, scope := describeCapability(req)
	switch {
	case !bytes.Equal(g.PayloadHash, payHash[:]):
		fmt.Printf("BINDING         MISMATCH — grant is not for the payload requested\n")
	case !bytes.Equal(g.AgentPub, req.AgentPub):
		fmt.Printf("BINDING         MISMATCH — grant names a different agent\n")
	default:
		fmt.Printf("BINDING         ok — %s (%s)\n", name, scope)
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

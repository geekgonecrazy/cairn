package core

import (
	"testing"

	"github.com/fxamacker/cbor/v2"

	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/identity"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
	"github.com/geekgonecrazy/cairn/store/sqlite"
)

// setTestStore points the package singleton at a fresh in-memory store. VisibleRooms
// and applyRoomState both read/write through Store(), so this is all the wiring a
// fold+discovery test needs.
func setTestStore(t *testing.T) {
	t.Helper()
	s, err := sqlite.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CheckDb(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	st = s
	hub = newHub() // SubmitEvent broadcasts on store; a nil hub would panic.
	configuredRoots = nil
	adoptedRoot = nil
	allowAdoption = true
}

// submitAs drives the REAL write path (chain gate → verify → store → fold) the
// way an event arriving over the wire does. The event is signed by `m`'s device
// key, so it only passes once the household is founded — this exercises the gate
// and the room-state dispatch together.
func submitAs(t *testing.T, m *testMember, target string, ts int64, typ cairnv1.EventType, p roomStatePayload) {
	t.Helper()
	body, err := cbor.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	payload := append([]byte{0x00}, body...)
	ev, err := event.Build(m.device.Pub, m.device.Priv, []byte(target), ts, nil, typ, payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := SubmitEvent(ev); err != nil {
		t.Fatalf("submit %v: %v", typ, err)
	}
}

// TestDiscoveryThroughSubmitEvent walks the headline flow over the real write
// path, now under the chain gate: an attested founder founds a space, grants a
// newcomer SPACE membership, and creates a discoverable and a hidden room — then
// the newcomer discovers the discoverable one (locked) and never the hidden one,
// asks to join, and is admitted. Every event is a signed, chain-verified sender.
func TestDiscoveryThroughSubmitEvent(t *testing.T) {
	setTestStore(t)
	hh := newHousehold(t)
	founder := hh.member(t, "Founder")
	newcomer := hh.member(t, "Newcomer")
	founder.install(t)
	newcomer.install(t)
	// Founding: the founder's attestation adopts the household root, opening the gate.
	if err := MaybeAdoptRoot(founder.att.Origin); err != nil {
		t.Fatal(err)
	}

	const space = "hh"
	ts := int64(1)
	next := func() int64 { ts++; return ts }
	submitAs(t, founder, space, next(), cairnv1.EventType_SPACE_CREATE, roomStatePayload{SpaceName: "Household"})
	submitAs(t, founder, space, next(), cairnv1.EventType_SPACE_MEMBER_ADD, roomStatePayload{MemberPub: newcomer.member.Pub, Role: "member"})
	submitAs(t, founder, "general", next(), cairnv1.EventType_ROOM_CREATE, roomStatePayload{Name: "general", SpaceID: []byte(space), Visibility: "discoverable"})
	submitAs(t, founder, "vault", next(), cairnv1.EventType_ROOM_CREATE, roomStatePayload{Name: "vault", SpaceID: []byte(space), Visibility: "hidden"})

	rooms, spaces, err := VisibleRooms(newcomer.member.Pub)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(rooms); !got["general"] || got["vault"] {
		t.Fatalf("newcomer should discover general but not vault, got %v", got)
	}
	if j, present := joinedByName(rooms, "general"); !present || j {
		t.Errorf("general should be discovered unjoined, got joined=%v present=%v", j, present)
	}
	if len(spaces) != 1 {
		t.Fatalf("newcomer should see the household space, got %v", spaces)
	}

	// The newcomer (a real attested sender) asks to join; the founder answers with
	// an add and the room flips to joined.
	submitAs(t, newcomer, "general", next(), cairnv1.EventType_ROOM_JOIN_REQUEST, roomStatePayload{MemberPub: newcomer.member.Pub})
	if reqs, _ := st.ListJoinRequests([]byte("general")); len(reqs) != 1 {
		t.Fatalf("expected one pending join request, got %d", len(reqs))
	}
	// The founder (a member) sees the pending count on the room so the sidebar can
	// badge it; the newcomer (not a member) must not.
	frooms, _, _ := VisibleRooms(founder.member.Pub)
	for _, vr := range frooms {
		if vr.Room.Name == "general" && vr.PendingRequests != 1 {
			t.Fatalf("founder should see 1 pending request on general, got %d", vr.PendingRequests)
		}
	}
	nrooms, _, _ := VisibleRooms(newcomer.member.Pub)
	for _, vr := range nrooms {
		if vr.Room.Name == "general" && vr.PendingRequests != 0 {
			t.Fatalf("newcomer (not a member) must not see pending counts, got %d", vr.PendingRequests)
		}
	}
	submitAs(t, founder, "general", next(), cairnv1.EventType_MEMBER_ADD, roomStatePayload{MemberPub: newcomer.member.Pub, Role: "member"})
	rooms, _, _ = VisibleRooms(newcomer.member.Pub)
	if j, _ := joinedByName(rooms, "general"); !j {
		t.Error("after the add, general should be joined for the newcomer")
	}
}

// fold builds a signed room-state event and folds it, exactly as SubmitEvent
// would after verifying and storing it. target is the room id for room-scoped
// events and the space id for space-scoped ones (space_create / space_member_add),
// mirroring the wire convention.
func fold(t *testing.T, kp identity.KeyPair, target string, typ cairnv1.EventType, p roomStatePayload) {
	t.Helper()
	body, err := cbor.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	payload := append([]byte{0x00}, body...) // uvarint(0) epoch frame || cbor
	ev, err := event.Build(kp.Pub, kp.Priv, []byte(target), 1, nil, typ, payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := applyRoomState(ev); err != nil {
		t.Fatalf("fold %v: %v", typ, err)
	}
}

func names(rooms []VisibleRoom) map[string]bool {
	m := map[string]bool{}
	for _, r := range rooms {
		m[r.Room.Name] = true
	}
	return m
}

func joinedByName(rooms []VisibleRoom, name string) (joined, present bool) {
	for _, r := range rooms {
		if r.Room.Name == name {
			return r.Joined, true
		}
	}
	return false, false
}

// TestVisibleRoomsTwoTiers is the headline: space membership grants DISCOVERY of
// a space's discoverable rooms (locked, joined=false), MEMBER_ADD grants a joined
// room, hidden rooms never leak through discovery, and a stranger sees nothing.
func TestVisibleRoomsTwoTiers(t *testing.T) {
	setTestStore(t)

	alice, _ := identity.GenerateKey() // founder + room member everywhere
	bob, _ := identity.GenerateKey()   // space member only — a pure discoverer
	carol, _ := identity.GenerateKey() // room member of general, NOT a space member
	dave, _ := identity.GenerateKey()  // stranger

	const space = "hh"
	fold(t, alice, space, cairnv1.EventType_SPACE_CREATE, roomStatePayload{SpaceName: "Household"})
	fold(t, alice, space, cairnv1.EventType_SPACE_MEMBER_ADD, roomStatePayload{MemberPub: alice.Pub, Role: "admin"})
	fold(t, alice, space, cairnv1.EventType_SPACE_MEMBER_ADD, roomStatePayload{MemberPub: bob.Pub, Role: "member"})

	fold(t, alice, "general", cairnv1.EventType_ROOM_CREATE, roomStatePayload{Name: "general", SpaceID: []byte(space), Visibility: "discoverable"})
	fold(t, alice, "secret", cairnv1.EventType_ROOM_CREATE, roomStatePayload{Name: "secret", SpaceID: []byte(space), Visibility: "hidden"})
	// A spaceless room: reachable only by direct membership, never by discovery.
	fold(t, alice, "orphan", cairnv1.EventType_ROOM_CREATE, roomStatePayload{Name: "orphan", Visibility: "discoverable"})

	for _, room := range []string{"general", "secret", "orphan"} {
		fold(t, alice, room, cairnv1.EventType_MEMBER_ADD, roomStatePayload{MemberPub: alice.Pub, Role: "admin"})
	}
	fold(t, alice, "general", cairnv1.EventType_MEMBER_ADD, roomStatePayload{MemberPub: carol.Pub, Role: "member"})

	// Alice: admitted to all three, joined everywhere.
	rooms, spaces, err := VisibleRooms(alice.Pub)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(rooms); !got["general"] || !got["secret"] || !got["orphan"] {
		t.Fatalf("alice should see all three rooms, got %v", got)
	}
	if j, _ := joinedByName(rooms, "secret"); !j {
		t.Error("alice should be joined to secret")
	}
	if len(spaces) != 1 || string(spaces[0].SpaceID) != space {
		t.Fatalf("alice should see one space (hh), got %v", spaces)
	}

	// Bob: space member only. Discovers `general` (locked), never `secret`
	// (hidden) or `orphan` (no space membership, no room membership).
	rooms, spaces, err = VisibleRooms(bob.Pub)
	if err != nil {
		t.Fatal(err)
	}
	got := names(rooms)
	if !got["general"] || got["secret"] || got["orphan"] {
		t.Fatalf("bob should discover only general, got %v", got)
	}
	if j, present := joinedByName(rooms, "general"); !present || j {
		t.Errorf("bob should see general unjoined (discovery), got joined=%v present=%v", j, present)
	}
	if len(spaces) != 1 {
		t.Fatalf("bob should see the hh space, got %v", spaces)
	}

	// Carol: a room member of general but NOT a space member. She sees general
	// (joined) and, through it, the hh space — but NOT sibling rooms she was
	// never added to. Room membership is not a discovery grant.
	rooms, _, err = VisibleRooms(carol.Pub)
	if err != nil {
		t.Fatal(err)
	}
	got = names(rooms)
	if !got["general"] || got["secret"] || got["orphan"] {
		t.Fatalf("carol should see only general, got %v", got)
	}
	if j, _ := joinedByName(rooms, "general"); !j {
		t.Error("carol should be joined to general")
	}

	// Dave: no membership of any kind. Empty — there is no default room.
	rooms, spaces, err = VisibleRooms(dave.Pub)
	if err != nil {
		t.Fatal(err)
	}
	if len(rooms) != 0 || len(spaces) != 0 {
		t.Fatalf("a stranger should see nothing, got rooms=%v spaces=%v", names(rooms), spaces)
	}
}

// TestRoomVisibilityDefault: an unset (or unrecognised) visibility folds to
// discoverable, so a room is hidden only when its author deliberately said so.
func TestRoomVisibilityDefault(t *testing.T) {
	setTestStore(t)
	alice, _ := identity.GenerateKey()
	fold(t, alice, "noflag", cairnv1.EventType_ROOM_CREATE, roomStatePayload{Name: "noflag"})
	r, err := st.GetRoom([]byte("noflag"))
	if err != nil || r == nil {
		t.Fatalf("get room: %v", err)
	}
	if r.Visibility != "discoverable" {
		t.Errorf("unset visibility should default to discoverable, got %q", r.Visibility)
	}
}

// TestSpaceUpdateAndMemberRemove: SPACE_UPDATE renames a space (and rewrites its
// admit policy), and SPACE_MEMBER_REMOVE revokes a discovery grant.
func TestSpaceUpdateAndMemberRemove(t *testing.T) {
	setTestStore(t)
	alice, _ := identity.GenerateKey()
	member, _ := identity.GenerateKey()

	const space = "sp-1"
	fold(t, alice, space, cairnv1.EventType_SPACE_CREATE, roomStatePayload{SpaceName: "Family", AdmitKind: "human,agent", AdmitOrigin: "own"})
	fold(t, alice, space, cairnv1.EventType_SPACE_MEMBER_ADD, roomStatePayload{MemberPub: member.Pub, Role: "member"})

	// Rename + tighten policy.
	fold(t, alice, space, cairnv1.EventType_SPACE_UPDATE, roomStatePayload{SpaceName: "Familia", AdmitKind: "human", AdmitOrigin: "any"})
	spaces, err := st.ListSpaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(spaces) != 1 || spaces[0].Name != "Familia" || spaces[0].AdmitKind != "human" || spaces[0].AdmitOrigin != "any" {
		t.Fatalf("space_update did not rewrite name/policy: %+v", spaces)
	}

	// Member is on the roster, then removed.
	if ms, _ := st.ListSpaceMembers([]byte(space)); len(ms) != 1 {
		t.Fatalf("expected 1 space member before remove, got %d", len(ms))
	}
	fold(t, alice, space, cairnv1.EventType_SPACE_MEMBER_REMOVE, roomStatePayload{MemberPub: member.Pub})
	if ms, _ := st.ListSpaceMembers([]byte(space)); len(ms) != 0 {
		t.Fatalf("space_member_remove should empty the roster, got %d", len(ms))
	}
}

// TestJoinRequestFold: a ROOM_JOIN_REQUEST folds into the room's pending list so
// members can answer it.
func TestJoinRequestFold(t *testing.T) {
	setTestStore(t)
	bob, _ := identity.GenerateKey()
	fold(t, bob, "general", cairnv1.EventType_ROOM_JOIN_REQUEST, roomStatePayload{MemberPub: bob.Pub, Reason: "let me in"})

	reqs, err := st.ListJoinRequests([]byte("general"))
	if err != nil {
		t.Fatal(err)
	}
	if len(reqs) != 1 || string(reqs[0].MemberPub) != string(bob.Pub) || reqs[0].Reason != "let me in" {
		t.Fatalf("expected bob's pending request, got %v", reqs)
	}
}

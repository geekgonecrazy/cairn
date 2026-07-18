// Package models holds Cairn's plain domain types — the shapes the store reads
// and writes and the controllers hand to the frontend. The wire/DAG type
// (cairnv1.Event) lives in proto; these are the derived, human-facing entities.
package models

// Room is a single conversation's metadata. The messages themselves are events
// in the room DAG (keyed by RoomID); this row is the durable handle plus the
// per-room transport preference. A Room optionally belongs to a Space.
type Room struct {
	RoomID        []byte `json:"room_id"`
	SpaceID       []byte `json:"space_id,omitempty"`
	Name          string `json:"name"`
	TransportPref string `json:"transport_pref,omitempty"` // auto|field|home|mesh-only|lan-only
	CreatedAt     int64  `json:"created_at"`               // unix ms
	// Visibility governs who a space member may see: "discoverable" rooms appear
	// (locked) to every member of the space; "hidden" rooms appear only to a
	// member a MEMBER_ADD admitted. Empty is treated as "discoverable".
	Visibility string `json:"visibility,omitempty"`
}

// Space is a policy boundary over a set of rooms: who may be admitted (kind and
// origin). See PROTOCOL.md §3 space_create/space_update.
type Space struct {
	SpaceID     []byte `json:"space_id"`
	Name        string `json:"name"`
	AdmitKind   string `json:"admit_kind"`   // e.g. "human" or "human,agent"
	AdmitOrigin string `json:"admit_origin"` // "own" | "any" | comma-joined root pubkeys (hex)
	Policy      []byte `json:"policy,omitempty"`
}

// Member is a member root's presence in a room, with the role the admit act gave
// it and the event that added it.
type Member struct {
	RoomID     []byte `json:"room_id"`
	MemberPub  []byte `json:"member_pub"`
	Role       string `json:"role"` // e.g. "admin" | "member"
	AddedEvent []byte `json:"added_event,omitempty"`
}

// SpaceMember is a member root's presence in a SPACE. Unlike Member it carries
// no key: it is the discovery tier — being a space member is what lets you see
// the discoverable rooms inside the space (and ask to join them). Keyed on the
// member root so a member's spaces follow them across devices, exactly like
// room membership.
type SpaceMember struct {
	SpaceID    []byte `json:"space_id"`
	MemberPub  []byte `json:"member_pub"`
	Role       string `json:"role"` // e.g. "admin" | "member"
	AddedEvent []byte `json:"added_event,omitempty"`
}

// JoinRequest is a discoverer asking to be admitted to a room they can see but
// hold no key for. It is folded from a signed ROOM_JOIN_REQUEST so existing
// members can see the ask and answer it with a MEMBER_ADD (the only act that can
// wrap the key). A request is satisfied once the requester appears in `members`
// for the room — there is no separate "accepted" record.
type JoinRequest struct {
	RoomID       []byte `json:"room_id"`
	MemberPub    []byte `json:"member_pub"`
	Reason       string `json:"reason,omitempty"`
	RequestEvent []byte `json:"request_event,omitempty"`
	RequestedAt  int64  `json:"requested_at"` // unix ms
}

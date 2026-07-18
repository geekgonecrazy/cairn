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

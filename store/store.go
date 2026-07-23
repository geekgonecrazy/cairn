// Package store is the persistence boundary. store.Store is the interface; the
// concrete backend lives in store/sqlite (pure-Go modernc driver). Following the
// rfd-tool/flockledger convention: an interface here, one implementation package
// per backend, entity methods grouped one file per concern in the impl.
//
// The store also IS an identity.Resolver — a chain walk reads the identity log
// straight from persisted state.
package store

import (
	"github.com/geekgonecrazy/cairn/identity"
	"github.com/geekgonecrazy/cairn/models"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// Store is Cairn's durable state: the room DAG, room/space/member metadata,
// local room keys, the household identity log, and the per-peer sync frontier.
type Store interface {
	// CheckDb creates the schema if absent. Dev phase: no migrations — wipe the
	// DB file to reset (see docs/protocol.md §10).
	CheckDb() error
	Close() error

	// --- events / DAG (docs/protocol.md §4) ---

	// PutEvent stores a (pre-verified) event idempotently and maintains room
	// heads. stored is false if the event_id was already present.
	PutEvent(ev *cairnv1.Event) (stored bool, err error)
	GetEvent(eventID []byte) (*cairnv1.Event, error)
	HasEvent(eventID []byte) (bool, error)
	// Heads returns the room's current frontier (events with no child), sorted.
	Heads(roomID []byte) ([][]byte, error)
	// Missing returns the subgraph reachable from the room's local heads but not
	// from haveHeads — the sync diff the caller lacks (docs/protocol.md §6).
	Missing(roomID []byte, haveHeads [][]byte) ([]*cairnv1.Event, error)
	// History walks parents backward from `before` (or from heads if empty),
	// newest first, up to limit events.
	History(roomID, before []byte, limit int) ([]*cairnv1.Event, error)

	// --- rooms / spaces / members ---

	PutRoom(*models.Room) error
	GetRoom(roomID []byte) (*models.Room, error)
	ListRooms() ([]*models.Room, error)
	PutSpace(*models.Space) error
	GetSpace(spaceID []byte) (*models.Space, error)
	ListSpaces() ([]*models.Space, error)
	PutMember(*models.Member) error
	ListMembers(roomID []byte) ([]*models.Member, error)
	// DeleteMember removes a member root from a room (folded from MEMBER_REMOVE).
	DeleteMember(roomID, memberPub []byte) error
	// Space membership — the space roster (the authority a channel roster must
	// stay within). SpaceMembershipsFor is the pubkey-keyed entry point ListRooms
	// uses to decide which spaces' rooms a caller may see. Folded last-writer-wins.
	PutSpaceMember(*models.SpaceMember) error
	ListSpaceMembers(spaceID []byte) ([]*models.SpaceMember, error)
	SpaceMembershipsFor(memberPub []byte) ([]*models.SpaceMember, error)
	// RemoveSpaceMember writes a revocation tombstone (folded from SPACE_MEMBER_REMOVE).
	RemoveSpaceMember(spaceID, memberPub []byte, ts int64) error
	// Join requests — a discoverer's ask to be admitted to a room they can see.
	PutJoinRequest(*models.JoinRequest) error
	ListJoinRequests(roomID []byte) ([]*models.JoinRequest, error)

	// --- room keys (local, unwrapped) ---

	PutRoomKey(roomID []byte, epoch uint64, key []byte) error
	GetRoomKey(roomID []byte, epoch uint64) ([]byte, error)

	// --- identity log (docs/protocol.md §1) ---

	PutAttestation(*identity.IdentityAttestation) error
	PutDeviceDelegation(*identity.DeviceDelegation) error
	PutSessionDelegation(*identity.SessionDelegation) error
	PutDeviceRevoke(*identity.DeviceRevoke) error
	// GetIdentityObject returns the raw CBOR of an identity-log object by its
	// BLAKE3 hash (serves GetIdentityObject over the wire).
	GetIdentityObject(hash []byte) ([]byte, error)
	// DevicesUnder returns every non-revoked device key in a member's tree, at
	// any depth — the set a room key must be wrapped to for that member, since
	// room keys seal to device keys rather than the offline member root.
	DevicesUnder(memberPub []byte) ([][]byte, error)

	// The store resolves a sender's chain from the identity log:
	// SessionDelegation / DeviceDelegation / DeviceRevokeFor / Attestation.
	// DeviceRevokeFor comes from here too, and serves ResolveSender: clients
	// get the signed revocation to verify, not an assertion to trust.
	identity.Resolver

	// --- sync frontier (per-peer outbox cursor, docs/protocol.md §6) ---

	PutPeerFrontier(peerPub, roomID []byte, heads [][]byte) error
	GetPeerFrontier(peerPub, roomID []byte) ([][]byte, error)

	// --- process metadata (small key/value; e.g. the adopted household root) ---

	PutMeta(key, value string) error
	// GetMeta returns the value and whether the key was present.
	GetMeta(key string) (string, bool, error)
}

// Package sqlite is the pure-Go (modernc, no cgo) store.Store backend. One
// binary schema, no migrations during the dev phase — CheckDb (re)creates it and
// you wipe the DB file to reset (PROTOCOL.md §10). One file per entity concern.
package sqlite

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"

	"github.com/geekgonecrazy/cairn/store"
)

// Store is the sqlite-backed implementation of store.Store.
type Store struct {
	db *sql.DB
}

// compile-time check that *Store satisfies the interface (incl. identity.Resolver).
var _ store.Store = (*Store)(nil)

// New opens (creating if needed) the sqlite database at path. Use ":memory:"
// for tests. Serializes writes with a single connection — SQLite is a local
// single-node store here, not a contended server DB.
func New(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("sqlite: open %s: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`); err != nil {
		db.Close()
		return nil, fmt.Errorf("sqlite: pragma: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// schema is the whole DB in one statement set. Dev phase: edit in place, no
// migrations. Mirrors PROTOCOL.md §10, except the identity log is a single
// content-addressed table (identity_log) indexed by the pubkey each object
// authorizes — serves both the chain-walk resolver and GetIdentityObject(hash).
const schema = `
CREATE TABLE IF NOT EXISTS events (
  event_id    BLOB PRIMARY KEY,
  room_id     BLOB NOT NULL,
  sender_pub  BLOB NOT NULL,
  ts          INTEGER NOT NULL,
  type        INTEGER NOT NULL,
  payload     BLOB NOT NULL,
  sig         BLOB NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, ts);

CREATE TABLE IF NOT EXISTS event_parents (
  event_id  BLOB NOT NULL,
  parent_id BLOB NOT NULL,
  PRIMARY KEY (event_id, parent_id)
);
CREATE INDEX IF NOT EXISTS idx_parents_parent ON event_parents(parent_id);

CREATE TABLE IF NOT EXISTS room_heads (
  room_id  BLOB NOT NULL,
  event_id BLOB NOT NULL,
  PRIMARY KEY (room_id, event_id)
);

CREATE TABLE IF NOT EXISTS rooms (
  room_id BLOB PRIMARY KEY, space_id BLOB, name TEXT,
  transport_pref TEXT, created_at INTEGER, visibility TEXT
);
CREATE TABLE IF NOT EXISTS spaces (
  space_id BLOB PRIMARY KEY, name TEXT,
  admit_kind TEXT, admit_origin TEXT, policy BLOB, owner BLOB
);
CREATE TABLE IF NOT EXISTS members (
  room_id BLOB, member_pub BLOB, role TEXT, added_event BLOB,
  PRIMARY KEY (room_id, member_pub)
);
-- Space membership is the discovery tier AND the authority: a space's roster is
-- the umbrella its channel rosters must stay within. Folded last-writer-wins by
-- ts (a stale add can't resurrect a later remove); removed=1 is a revocation
-- tombstone kept so ordering stays deterministic.
CREATE TABLE IF NOT EXISTS space_members (
  space_id BLOB, member_pub BLOB, role TEXT, added_event BLOB,
  ts INTEGER DEFAULT 0, removed INTEGER DEFAULT 0,
  PRIMARY KEY (space_id, member_pub)
);
-- Pending asks from discoverers who can see a room but hold no key. Folded from
-- ROOM_JOIN_REQUEST; satisfied (implicitly) once the requester joins members.
CREATE TABLE IF NOT EXISTS join_requests (
  room_id BLOB, member_pub BLOB, reason TEXT, request_event BLOB, requested_at INTEGER,
  PRIMARY KEY (room_id, member_pub)
);

CREATE TABLE IF NOT EXISTS room_keys (
  room_id BLOB, epoch INTEGER, key BLOB,
  PRIMARY KEY (room_id, epoch)
);

CREATE TABLE IF NOT EXISTS identity_log (
  hash        BLOB PRIMARY KEY,
  obj_type    TEXT NOT NULL,
  subject_pub BLOB NOT NULL,
  -- The parent a device delegation names, denormalized out of the CBOR so the
  -- tree can be walked DOWNWARD without decoding every row. Needed because room
  -- keys wrap to device keys: admitting a member means finding every device
  -- below their member root. NULL for every other object type.
  parent_pub  BLOB,
  cbor        BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_subject ON identity_log(obj_type, subject_pub);
CREATE INDEX IF NOT EXISTS idx_identity_parent ON identity_log(obj_type, parent_pub);

CREATE TABLE IF NOT EXISTS peer_frontier (
  peer_pub BLOB, room_id BLOB, head_id BLOB,
  PRIMARY KEY (peer_pub, room_id, head_id)
);

CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
`

// CheckDb creates the schema if it does not yet exist.
func (s *Store) CheckDb() error {
	if _, err := s.db.Exec(schema); err != nil {
		return fmt.Errorf("sqlite: create schema: %w", err)
	}
	return nil
}

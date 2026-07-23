package sqlite

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/geekgonecrazy/cairn/event"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// PutEvent stores ev idempotently (dedup by event_id) and maintains room_heads.
// The caller is responsible for having verified ev (event.Verify + identity
// chain) first — the store persists, it does not judge trust.
//
// Head maintenance under out-of-order delivery (docs/protocol.md §4):
//   - ev's parents can no longer be heads (ev is their child) → delete them.
//   - ev is a head UNLESS some already-stored event names ev as a parent (a
//     child arrived before its parent) → only then insert ev as a head.
func (s *Store) PutEvent(ev *cairnv1.Event) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	res, err := tx.Exec(
		`INSERT OR IGNORE INTO events(event_id,room_id,sender_pub,ts,type,payload,sig,received_at)
		 VALUES(?,?,?,?,?,?,?,?)`,
		ev.EventId, ev.RoomId, ev.SenderPub, ev.Ts, int32(ev.Type), ev.Payload, ev.Sig, nowMs(),
	)
	if err != nil {
		return false, fmt.Errorf("sqlite: insert event: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, nil // already had it
	}

	for _, p := range event.SortParents(ev.Parents) {
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO event_parents(event_id,parent_id) VALUES(?,?)`, ev.EventId, p,
		); err != nil {
			return false, fmt.Errorf("sqlite: insert parent edge: %w", err)
		}
		// A parent is now known to have a child → it is not a head.
		if _, err := tx.Exec(
			`DELETE FROM room_heads WHERE room_id=? AND event_id=?`, ev.RoomId, p,
		); err != nil {
			return false, err
		}
	}

	// ev is a head only if nothing already references it as a parent.
	var childCount int
	if err := tx.QueryRow(
		`SELECT COUNT(1) FROM event_parents WHERE parent_id=?`, ev.EventId,
	).Scan(&childCount); err != nil {
		return false, err
	}
	if childCount == 0 {
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO room_heads(room_id,event_id) VALUES(?,?)`, ev.RoomId, ev.EventId,
		); err != nil {
			return false, err
		}
	}

	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// scanEvent reconstructs an Event (with its parents) from a row's columns.
func (s *Store) hydrate(eventID, roomID, senderPub []byte, ts int64, typ int32, payload, sig []byte) (*cairnv1.Event, error) {
	rows, err := s.db.Query(`SELECT parent_id FROM event_parents WHERE event_id=?`, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var parents [][]byte
	for rows.Next() {
		var p []byte
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		parents = append(parents, p)
	}
	return &cairnv1.Event{
		EventId:   eventID,
		RoomId:    roomID,
		SenderPub: senderPub,
		Ts:        ts,
		Parents:   event.SortParents(parents),
		Type:      cairnv1.EventType(typ),
		Payload:   payload,
		Sig:       sig,
	}, rows.Err()
}

// GetEvent returns the event by id, or (nil, nil) if not present.
func (s *Store) GetEvent(eventID []byte) (*cairnv1.Event, error) {
	var (
		roomID, senderPub, payload, sig []byte
		ts                              int64
		typ                             int32
	)
	err := s.db.QueryRow(
		`SELECT room_id,sender_pub,ts,type,payload,sig FROM events WHERE event_id=?`, eventID,
	).Scan(&roomID, &senderPub, &ts, &typ, &payload, &sig)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.hydrate(eventID, roomID, senderPub, ts, typ, payload, sig)
}

func (s *Store) HasEvent(eventID []byte) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM events WHERE event_id=?`, eventID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// Heads returns the room's current frontier, sorted ascending.
func (s *Store) Heads(roomID []byte) ([][]byte, error) {
	rows, err := s.db.Query(
		`SELECT event_id FROM room_heads WHERE room_id=? ORDER BY event_id`, roomID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var heads [][]byte
	for rows.Next() {
		var h []byte
		if err := rows.Scan(&h); err != nil {
			return nil, err
		}
		heads = append(heads, h)
	}
	return heads, rows.Err()
}

// Missing returns events reachable from the room's local heads but not from
// haveHeads: walk parents back from local heads, stopping whenever we reach an
// id the peer already has (docs/protocol.md §6). Returned oldest-first (best-effort
// causal order) so a client can apply parents before children.
func (s *Store) Missing(roomID []byte, haveHeads [][]byte) ([]*cairnv1.Event, error) {
	have := make(map[string]bool, len(haveHeads))
	for _, h := range haveHeads {
		have[string(h)] = true
	}
	localHeads, err := s.Heads(roomID)
	if err != nil {
		return nil, err
	}

	visited := map[string]bool{}
	var collected []*cairnv1.Event
	queue := append([][]byte(nil), localHeads...)
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		key := string(id)
		if visited[key] || have[key] {
			continue
		}
		visited[key] = true
		ev, err := s.GetEvent(id)
		if err != nil {
			return nil, err
		}
		if ev == nil {
			continue // we reference it but don't have it; nothing to send
		}
		collected = append(collected, ev)
		queue = append(queue, ev.Parents...)
	}
	// Reverse to oldest-first.
	for i, j := 0, len(collected)-1; i < j; i, j = i+1, j-1 {
		collected[i], collected[j] = collected[j], collected[i]
	}
	return collected, nil
}

// History walks parents backward from `before` (or from heads when empty),
// newest-first, up to limit events.
func (s *Store) History(roomID, before []byte, limit int) ([]*cairnv1.Event, error) {
	if limit <= 0 {
		limit = 50
	}
	var seeds [][]byte
	if len(before) == 0 {
		var err error
		if seeds, err = s.Heads(roomID); err != nil {
			return nil, err
		}
	} else {
		seeds = [][]byte{before}
	}

	visited := map[string]bool{}
	var out []*cairnv1.Event
	queue := append([][]byte(nil), seeds...)
	for len(queue) > 0 && len(out) < limit {
		id := queue[0]
		queue = queue[1:]
		if visited[string(id)] {
			continue
		}
		visited[string(id)] = true
		ev, err := s.GetEvent(id)
		if err != nil {
			return nil, err
		}
		if ev == nil {
			continue
		}
		out = append(out, ev)
		queue = append(queue, ev.Parents...)
	}
	return out, nil
}

func nowMs() int64 { return time.Now().UnixMilli() }

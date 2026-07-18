package sqlite

import (
	"database/sql"
	"errors"

	"github.com/geekgonecrazy/cairn/models"
)

func (s *Store) PutRoom(r *models.Room) error {
	_, err := s.db.Exec(
		`INSERT INTO rooms(room_id,space_id,name,transport_pref,created_at) VALUES(?,?,?,?,?)
		 ON CONFLICT(room_id) DO UPDATE SET space_id=excluded.space_id, name=excluded.name,
		   transport_pref=excluded.transport_pref`,
		r.RoomID, r.SpaceID, r.Name, r.TransportPref, r.CreatedAt,
	)
	return err
}

func (s *Store) GetRoom(roomID []byte) (*models.Room, error) {
	var r models.Room
	err := s.db.QueryRow(
		`SELECT room_id,space_id,name,transport_pref,created_at FROM rooms WHERE room_id=?`, roomID,
	).Scan(&r.RoomID, &r.SpaceID, &r.Name, &r.TransportPref, &r.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) ListRooms() ([]*models.Room, error) {
	rows, err := s.db.Query(
		`SELECT room_id,space_id,name,transport_pref,created_at FROM rooms ORDER BY created_at`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Room
	for rows.Next() {
		var r models.Room
		if err := rows.Scan(&r.RoomID, &r.SpaceID, &r.Name, &r.TransportPref, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (s *Store) PutSpace(sp *models.Space) error {
	_, err := s.db.Exec(
		`INSERT INTO spaces(space_id,name,admit_kind,admit_origin,policy) VALUES(?,?,?,?,?)
		 ON CONFLICT(space_id) DO UPDATE SET name=excluded.name, admit_kind=excluded.admit_kind,
		   admit_origin=excluded.admit_origin, policy=excluded.policy`,
		sp.SpaceID, sp.Name, sp.AdmitKind, sp.AdmitOrigin, sp.Policy,
	)
	return err
}

func (s *Store) ListSpaces() ([]*models.Space, error) {
	rows, err := s.db.Query(`SELECT space_id,name,admit_kind,admit_origin,policy FROM spaces ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Space
	for rows.Next() {
		var sp models.Space
		if err := rows.Scan(&sp.SpaceID, &sp.Name, &sp.AdmitKind, &sp.AdmitOrigin, &sp.Policy); err != nil {
			return nil, err
		}
		out = append(out, &sp)
	}
	return out, rows.Err()
}

func (s *Store) PutMember(m *models.Member) error {
	_, err := s.db.Exec(
		`INSERT INTO members(room_id,member_pub,role,added_event) VALUES(?,?,?,?)
		 ON CONFLICT(room_id,member_pub) DO UPDATE SET role=excluded.role, added_event=excluded.added_event`,
		m.RoomID, m.MemberPub, m.Role, m.AddedEvent,
	)
	return err
}

func (s *Store) ListMembers(roomID []byte) ([]*models.Member, error) {
	rows, err := s.db.Query(
		`SELECT room_id,member_pub,role,added_event FROM members WHERE room_id=?`, roomID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Member
	for rows.Next() {
		var m models.Member
		if err := rows.Scan(&m.RoomID, &m.MemberPub, &m.Role, &m.AddedEvent); err != nil {
			return nil, err
		}
		out = append(out, &m)
	}
	return out, rows.Err()
}

func (s *Store) PutRoomKey(roomID []byte, epoch uint64, key []byte) error {
	_, err := s.db.Exec(
		`INSERT INTO room_keys(room_id,epoch,key) VALUES(?,?,?)
		 ON CONFLICT(room_id,epoch) DO UPDATE SET key=excluded.key`,
		roomID, int64(epoch), key,
	)
	return err
}

func (s *Store) GetRoomKey(roomID []byte, epoch uint64) ([]byte, error) {
	var key []byte
	err := s.db.QueryRow(`SELECT key FROM room_keys WHERE room_id=? AND epoch=?`, roomID, int64(epoch)).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return key, err
}

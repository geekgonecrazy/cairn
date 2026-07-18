package sqlite

import (
	"database/sql"
	"errors"

	"github.com/geekgonecrazy/cairn/models"
)

func (s *Store) PutRoom(r *models.Room) error {
	_, err := s.db.Exec(
		`INSERT INTO rooms(room_id,space_id,name,transport_pref,created_at,visibility) VALUES(?,?,?,?,?,?)
		 ON CONFLICT(room_id) DO UPDATE SET space_id=excluded.space_id, name=excluded.name,
		   transport_pref=excluded.transport_pref, visibility=excluded.visibility`,
		r.RoomID, r.SpaceID, r.Name, r.TransportPref, r.CreatedAt, r.Visibility,
	)
	return err
}

func (s *Store) GetRoom(roomID []byte) (*models.Room, error) {
	var r models.Room
	var vis sql.NullString
	err := s.db.QueryRow(
		`SELECT room_id,space_id,name,transport_pref,created_at,visibility FROM rooms WHERE room_id=?`, roomID,
	).Scan(&r.RoomID, &r.SpaceID, &r.Name, &r.TransportPref, &r.CreatedAt, &vis)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Visibility = vis.String
	return &r, nil
}

func (s *Store) ListRooms() ([]*models.Room, error) {
	rows, err := s.db.Query(
		`SELECT room_id,space_id,name,transport_pref,created_at,visibility FROM rooms ORDER BY created_at`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Room
	for rows.Next() {
		var r models.Room
		var vis sql.NullString
		if err := rows.Scan(&r.RoomID, &r.SpaceID, &r.Name, &r.TransportPref, &r.CreatedAt, &vis); err != nil {
			return nil, err
		}
		r.Visibility = vis.String
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

func (s *Store) PutSpaceMember(m *models.SpaceMember) error {
	_, err := s.db.Exec(
		`INSERT INTO space_members(space_id,member_pub,role,added_event) VALUES(?,?,?,?)
		 ON CONFLICT(space_id,member_pub) DO UPDATE SET role=excluded.role, added_event=excluded.added_event`,
		m.SpaceID, m.MemberPub, m.Role, m.AddedEvent,
	)
	return err
}

// ListSpaceMembers returns every member root admitted to a space (the space
// roster).
func (s *Store) ListSpaceMembers(spaceID []byte) ([]*models.SpaceMember, error) {
	rows, err := s.db.Query(
		`SELECT space_id,member_pub,role,added_event FROM space_members WHERE space_id=?`, spaceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.SpaceMember
	for rows.Next() {
		var m models.SpaceMember
		if err := rows.Scan(&m.SpaceID, &m.MemberPub, &m.Role, &m.AddedEvent); err != nil {
			return nil, err
		}
		out = append(out, &m)
	}
	return out, rows.Err()
}

// SpaceMembershipsFor returns every space a member root belongs to — the entry
// point for discovery: ListRooms uses it to decide which spaces' rooms a caller
// may see.
func (s *Store) SpaceMembershipsFor(memberPub []byte) ([]*models.SpaceMember, error) {
	rows, err := s.db.Query(
		`SELECT space_id,member_pub,role,added_event FROM space_members WHERE member_pub=?`, memberPub,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.SpaceMember
	for rows.Next() {
		var m models.SpaceMember
		if err := rows.Scan(&m.SpaceID, &m.MemberPub, &m.Role, &m.AddedEvent); err != nil {
			return nil, err
		}
		out = append(out, &m)
	}
	return out, rows.Err()
}

func (s *Store) DeleteSpaceMember(spaceID, memberPub []byte) error {
	_, err := s.db.Exec(`DELETE FROM space_members WHERE space_id=? AND member_pub=?`, spaceID, memberPub)
	return err
}

func (s *Store) PutJoinRequest(r *models.JoinRequest) error {
	_, err := s.db.Exec(
		`INSERT INTO join_requests(room_id,member_pub,reason,request_event,requested_at) VALUES(?,?,?,?,?)
		 ON CONFLICT(room_id,member_pub) DO UPDATE SET reason=excluded.reason,
		   request_event=excluded.request_event, requested_at=excluded.requested_at`,
		r.RoomID, r.MemberPub, r.Reason, r.RequestEvent, r.RequestedAt,
	)
	return err
}

// ListJoinRequests returns the pending join requests for a room. A request is
// "pending" only until the requester is admitted; callers filter out anyone who
// already appears in ListMembers, since a fulfilled request leaves no separate
// record.
func (s *Store) ListJoinRequests(roomID []byte) ([]*models.JoinRequest, error) {
	rows, err := s.db.Query(
		`SELECT room_id,member_pub,reason,request_event,requested_at FROM join_requests WHERE room_id=? ORDER BY requested_at`, roomID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.JoinRequest
	for rows.Next() {
		var r models.JoinRequest
		var reason sql.NullString
		if err := rows.Scan(&r.RoomID, &r.MemberPub, &reason, &r.RequestEvent, &r.RequestedAt); err != nil {
			return nil, err
		}
		r.Reason = reason.String
		out = append(out, &r)
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

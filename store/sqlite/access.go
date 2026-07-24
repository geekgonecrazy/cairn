package sqlite

import (
	"database/sql"
	"errors"

	"github.com/geekgonecrazy/cairn/models"
)

// Relay access: the allow-list (member roots this relay carries) and the
// single-use invite consumption ledger. See models.AllowedMember and
// docs/adrs/0014-relay-operational-admission.md — operational admission, not identity trust.

func (s *Store) AllowMember(memberPub []byte, via string, at int64) error {
	_, err := s.db.Exec(
		`INSERT INTO allow_list(member_pub,added_at,via) VALUES(?,?,?)
		 ON CONFLICT(member_pub) DO NOTHING`,
		memberPub, at, via,
	)
	return err
}

func (s *Store) IsAllowed(memberPub []byte) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM allow_list WHERE member_pub=?`, memberPub).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) ListAllowed() ([]*models.AllowedMember, error) {
	rows, err := s.db.Query(`SELECT member_pub,added_at,via FROM allow_list ORDER BY added_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.AllowedMember
	for rows.Next() {
		m := &models.AllowedMember{}
		if err := rows.Scan(&m.MemberPub, &m.AddedAt, &m.Via); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) RemoveAllowed(memberPub []byte) error {
	_, err := s.db.Exec(`DELETE FROM allow_list WHERE member_pub=?`, memberPub)
	return err
}

// ConsumeInvite records an invite id as consumed. The INSERT ... ON CONFLICT DO
// NOTHING makes it atomic and single-use: a second redemption of the same id
// affects no rows and returns false.
func (s *Store) ConsumeInvite(id, memberPub []byte, at int64) (bool, error) {
	res, err := s.db.Exec(
		`INSERT INTO consumed_invites(id,consumed_at,member_pub) VALUES(?,?,?)
		 ON CONFLICT(id) DO NOTHING`,
		id, at, memberPub,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

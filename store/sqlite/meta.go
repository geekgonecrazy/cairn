package sqlite

import (
	"database/sql"
	"errors"
)

// The meta table is a small key/value store for process-level state that is not
// part of the DAG or the identity log — currently the household root this carrier
// adopted at founding (core.MaybeAdoptRoot), so enforcement survives a restart.

func (s *Store) PutMeta(key, value string) error {
	_, err := s.db.Exec(
		`INSERT INTO meta(key,value) VALUES(?,?)
		 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		key, value,
	)
	return err
}

// GetMeta returns the value and whether the key was present.
func (s *Store) GetMeta(key string) (string, bool, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}

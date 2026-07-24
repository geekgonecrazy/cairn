package sqlite

// The per-peer sync frontier is the durable "what's undelivered" cursor — a diff
// over the DAG, not a queue (docs/adrs/0003-signed-event-dag.md / docs/protocol.md §6). We store the set of
// head ids we last knew a peer had for a room; "undelivered to peer X" is then
// the local subgraph not reachable from that frontier (Missing).

// PutPeerFrontier replaces the recorded frontier for (peerPub, roomID).
func (s *Store) PutPeerFrontier(peerPub, roomID []byte, heads [][]byte) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`DELETE FROM peer_frontier WHERE peer_pub=? AND room_id=?`, peerPub, roomID,
	); err != nil {
		return err
	}
	for _, h := range heads {
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO peer_frontier(peer_pub,room_id,head_id) VALUES(?,?,?)`,
			peerPub, roomID, h,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetPeerFrontier returns the last-known heads for (peerPub, roomID).
func (s *Store) GetPeerFrontier(peerPub, roomID []byte) ([][]byte, error) {
	rows, err := s.db.Query(
		`SELECT head_id FROM peer_frontier WHERE peer_pub=? AND room_id=?`, peerPub, roomID,
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

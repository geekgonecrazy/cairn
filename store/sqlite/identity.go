package sqlite

import (
	"database/sql"
	"errors"

	"github.com/fxamacker/cbor/v2"

	"github.com/geekgonecrazy/cairn/identity"
)

// The identity log is one content-addressed table. obj_type + subject_pub index
// the chain-walk resolver; hash serves GetIdentityObject. subject_pub is the key
// each object AUTHORIZES: session_pub, device_pub, member_pub, or (for a revoke)
// the revoked device_pub.
const (
	objAttestation      = "attestation"
	objDeviceDelegation = "device_delegation"
	objSessionDeleg     = "session_delegation"
	objDeviceRevoke     = "device_revoke"
)

// putIdentityObject stores one object. parentPub is the delegation's parent for
// device delegations and nil otherwise — it exists so the device tree can be
// walked downward (see DevicesUnder) without decoding every row's CBOR.
func (s *Store) putIdentityObject(objType string, subjectPub, parentPub []byte, obj any) error {
	blob, err := identity.Marshal(obj)
	if err != nil {
		return err
	}
	hash, err := identity.Hash(obj)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`INSERT OR IGNORE INTO identity_log(hash,obj_type,subject_pub,parent_pub,cbor) VALUES(?,?,?,?,?)`,
		hash[:], objType, subjectPub, parentPub, blob,
	)
	return err
}

func (s *Store) PutAttestation(a *identity.IdentityAttestation) error {
	return s.putIdentityObject(objAttestation, a.Pubkey, nil, a)
}
func (s *Store) PutDeviceDelegation(d *identity.DeviceDelegation) error {
	return s.putIdentityObject(objDeviceDelegation, d.DevicePub, d.ParentPub, d)
}
func (s *Store) PutSessionDelegation(d *identity.SessionDelegation) error {
	return s.putIdentityObject(objSessionDeleg, d.SessionPub, nil, d)
}
func (s *Store) PutDeviceRevoke(d *identity.DeviceRevoke) error {
	return s.putIdentityObject(objDeviceRevoke, d.DevicePub, nil, d)
}

// DevicesUnder returns every non-revoked device key in memberPub's tree, at any
// depth. This is the wrap target set for a member: room keys are sealed to
// DEVICE keys, so admitting a member means sealing to each of their devices.
//
// A device is excluded if it OR any ancestor is revoked — the same cascade the
// chain walk applies, so this never hands a key to a device that has in fact
// stopped working. Bounded by identity.MaxChainDepth.
func (s *Store) DevicesUnder(memberPub []byte) ([][]byte, error) {
	frontier := [][]byte{memberPub}
	var out [][]byte

	for range identity.MaxChainDepth {
		// Collect this level's children FIRST, closing each cursor before doing
		// anything else with the connection. The revocation check below is
		// another query, and issuing it while a rows cursor is still open on the
		// same connection deadlocks.
		var children [][]byte
		for _, parent := range frontier {
			rows, err := s.db.Query(
				`SELECT subject_pub FROM identity_log WHERE obj_type=? AND parent_pub=?`,
				objDeviceDelegation, parent,
			)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var child []byte
				if err := rows.Scan(&child); err != nil {
					rows.Close()
					return nil, err
				}
				children = append(children, child)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return nil, err
			}
		}

		var next [][]byte
		for _, child := range children {
			// A revoked device takes its whole subtree with it: not descending
			// into it is what makes the cascade apply to the wrap set too.
			if s.DeviceRevoked(child) {
				continue
			}
			next = append(next, child)
			out = append(out, child)
		}
		if len(next) == 0 {
			break
		}
		frontier = next
	}
	return out, nil
}

// DeviceRevoked reports whether a revocation object exists for devicePub.
//
// NOTE: this does NOT check that the revoker had standing — the table files an
// object under whatever subject it names. It is used only where a conservative
// answer is right (excluding a device from a key wrap), never to decide whether
// to accept a sender; VerifySender does that against the delegation tree.
func (s *Store) DeviceRevoked(devicePub []byte) bool {
	var one int
	err := s.db.QueryRow(
		`SELECT 1 FROM identity_log WHERE obj_type=? AND subject_pub=? LIMIT 1`,
		objDeviceRevoke, devicePub,
	).Scan(&one)
	return err == nil
}

// GetIdentityObject returns the raw CBOR of an object by its BLAKE3 hash, or
// (nil, nil) if unknown.
func (s *Store) GetIdentityObject(hash []byte) ([]byte, error) {
	var blob []byte
	err := s.db.QueryRow(`SELECT cbor FROM identity_log WHERE hash=?`, hash).Scan(&blob)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return blob, err
}

// lookup fetches the single object of a type authorizing subjectPub and CBOR-
// decodes it into out. Returns false if absent or on decode error (the chain
// walk treats that as "fetch and retry" / reject, never a panic).
func (s *Store) lookup(objType string, subjectPub []byte, out any) bool {
	var blob []byte
	err := s.db.QueryRow(
		`SELECT cbor FROM identity_log WHERE obj_type=? AND subject_pub=? LIMIT 1`, objType, subjectPub,
	).Scan(&blob)
	if err != nil {
		return false
	}
	return cbor.Unmarshal(blob, out) == nil
}

// --- identity.Resolver ---

func (s *Store) SessionDelegation(sessionPub []byte) (*identity.SessionDelegation, bool) {
	var d identity.SessionDelegation
	if !s.lookup(objSessionDeleg, sessionPub, &d) {
		return nil, false
	}
	return &d, true
}

func (s *Store) DeviceDelegation(devicePub []byte) (*identity.DeviceDelegation, bool) {
	var d identity.DeviceDelegation
	if !s.lookup(objDeviceDelegation, devicePub, &d) {
		return nil, false
	}
	return &d, true
}

// DeviceRevokeFor implements identity.Resolver and serves ResolveSender.
//
// It deliberately returns the signed object rather than a verdict. This table
// files an object under whatever subject_pub it names, with no check that the
// signer had any standing to revoke it — so "a row exists" is not "this device
// is revoked". VerifySender decides that, by checking the revoke against the
// delegation. Handing clients the object rather than a boolean serves the same
// principle over the wire: telling a client "revoked, trust me" would make the
// server an authority.
func (s *Store) DeviceRevokeFor(devicePub []byte) (*identity.DeviceRevoke, bool) {
	var d identity.DeviceRevoke
	if !s.lookup(objDeviceRevoke, devicePub, &d) {
		return nil, false
	}
	return &d, true
}

func (s *Store) Attestation(memberPub []byte) (*identity.IdentityAttestation, bool) {
	var a identity.IdentityAttestation
	if !s.lookup(objAttestation, memberPub, &a) {
		return nil, false
	}
	return &a, true
}

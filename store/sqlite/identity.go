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

func (s *Store) putIdentityObject(objType string, subjectPub []byte, obj any) error {
	blob, err := identity.Marshal(obj)
	if err != nil {
		return err
	}
	hash, err := identity.Hash(obj)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`INSERT OR IGNORE INTO identity_log(hash,obj_type,subject_pub,cbor) VALUES(?,?,?,?)`,
		hash[:], objType, subjectPub, blob,
	)
	return err
}

func (s *Store) PutAttestation(a *identity.IdentityAttestation) error {
	return s.putIdentityObject(objAttestation, a.Pubkey, a)
}
func (s *Store) PutDeviceDelegation(d *identity.DeviceDelegation) error {
	return s.putIdentityObject(objDeviceDelegation, d.DevicePub, d)
}
func (s *Store) PutSessionDelegation(d *identity.SessionDelegation) error {
	return s.putIdentityObject(objSessionDeleg, d.SessionPub, d)
}
func (s *Store) PutDeviceRevoke(d *identity.DeviceRevoke) error {
	return s.putIdentityObject(objDeviceRevoke, d.DevicePub, d)
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

func (s *Store) DeviceRevoked(devicePub []byte) bool {
	var one int
	err := s.db.QueryRow(
		`SELECT 1 FROM identity_log WHERE obj_type=? AND subject_pub=? LIMIT 1`, objDeviceRevoke, devicePub,
	).Scan(&one)
	return err == nil
}

func (s *Store) Attestation(memberPub []byte) (*identity.IdentityAttestation, bool) {
	var a identity.IdentityAttestation
	if !s.lookup(objAttestation, memberPub, &a) {
		return nil, false
	}
	return &a, true
}

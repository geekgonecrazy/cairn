package identity

// The identity log: the household's append-only, self-verifying set of
// attestations, delegations and revocations.
//
// It is a SET, not a chain. Every object is independently signed and content-
// addressed, so two devices that learn objects in different orders converge to
// the same trust state — the same property the room DAG has, without needing
// causal parents. That is what lets a device that was offline during a
// revocation reach the correct conclusion the moment it syncs.
//
// Conflict rule: REVOCATION WINS, irrespective of arrival order or timestamp.
// A device key that has ever been revoked stays revoked, and re-pairing the
// same key is refused — a revoked key is assumed compromised, and a member root
// that could un-revoke it would give an attacker who stole one device a way to
// re-admit it by replaying an older delegation.

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"sync"
)

// DeviceLog is an in-memory identity log. It verifies every object's signature
// on insert, so anything it returns has already been checked; VerifySender
// re-checks regardless, since a Resolver may be backed by untrusted storage.
//
// Safe for concurrent use.
type DeviceLog struct {
	mu sync.RWMutex

	attestations map[string]*IdentityAttestation // member pubkey hex → attestation
	delegations  map[string]*DeviceDelegation    // device pubkey hex → delegation
	sessions     map[string]*SessionDelegation   // session pubkey hex → delegation
	revoked      map[string]*DeviceRevoke        // device pubkey hex → revoke
}

// NewDeviceLog returns an empty log.
func NewDeviceLog() *DeviceLog {
	return &DeviceLog{
		attestations: map[string]*IdentityAttestation{},
		delegations:  map[string]*DeviceDelegation{},
		sessions:     map[string]*SessionDelegation{},
		revoked:      map[string]*DeviceRevoke{},
	}
}

// AddAttestation verifies an attestation against its claimed household origin
// and stores it. The origin is self-declared here; trust in that origin is a
// separate decision made by VerifySender against trustedRoots.
func (l *DeviceLog) AddAttestation(att *IdentityAttestation) error {
	if att == nil {
		return fmt.Errorf("identity: nil attestation")
	}
	if len(att.Pubkey) != ed25519.PublicKeySize {
		return fmt.Errorf("identity: attestation pubkey must be %d bytes", ed25519.PublicKeySize)
	}
	if !verifySig(att, att.Origin, att.Sig) {
		return fmt.Errorf("attestation for %x: %w", att.Pubkey, ErrBadSignature)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	key := hex.EncodeToString(att.Pubkey)
	// kind and origin are immutable (PROTOCOL.md §1): a second, conflicting
	// attestation for the same member is an attack or a bug, never an update.
	if prev, ok := l.attestations[key]; ok {
		if prev.Kind != att.Kind || !bytes.Equal(prev.Origin, att.Origin) {
			return fmt.Errorf("identity: conflicting attestation for member %x "+
				"(kind/origin are immutable)", att.Pubkey)
		}
	}
	l.attestations[key] = att
	return nil
}

// AddDelegation verifies a device delegation against the member root that
// signed it and stores it. Refused if the device key is already revoked.
func (l *DeviceLog) AddDelegation(dd *DeviceDelegation) error {
	if dd == nil {
		return fmt.Errorf("identity: nil delegation")
	}
	if !verifySig(dd, dd.MemberPub, dd.Sig) {
		return fmt.Errorf("delegation for %x: %w", dd.DevicePub, ErrBadSignature)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	key := hex.EncodeToString(dd.DevicePub)
	if _, gone := l.revoked[key]; gone {
		return fmt.Errorf("device %x: %w (revoked keys cannot be re-paired)",
			dd.DevicePub, ErrRevoked)
	}
	// A device belongs to exactly one member root. Rebinding it to another is
	// how a stolen delegation would be laundered into a different identity.
	if prev, ok := l.delegations[key]; ok && !bytes.Equal(prev.MemberPub, dd.MemberPub) {
		return fmt.Errorf("identity: device %x already delegated to member %x",
			dd.DevicePub, prev.MemberPub)
	}
	l.delegations[key] = dd
	return nil
}

// AddSessionDelegation verifies a session delegation against its device key and
// stores it.
func (l *DeviceLog) AddSessionDelegation(sd *SessionDelegation) error {
	if sd == nil {
		return fmt.Errorf("identity: nil session delegation")
	}
	if !verifySig(sd, sd.DevicePub, sd.Sig) {
		return fmt.Errorf("session delegation for %x: %w", sd.SessionPub, ErrBadSignature)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sessions[hex.EncodeToString(sd.SessionPub)] = sd
	return nil
}

// AddRevoke verifies a revocation and applies it. The revocation must be signed
// by the same member root that holds the delegation, when one is known — this
// stops one member from revoking another member's devices.
//
// A revoke for an unknown device is accepted and remembered (tombstoned), so a
// delegation that arrives later is still refused.
func (l *DeviceLog) AddRevoke(dr *DeviceRevoke) error {
	if dr == nil {
		return fmt.Errorf("identity: nil revoke")
	}
	if !verifySig(dr, dr.MemberPub, dr.Sig) {
		return fmt.Errorf("revoke for %x: %w", dr.DevicePub, ErrBadSignature)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	key := hex.EncodeToString(dr.DevicePub)
	if dd, ok := l.delegations[key]; ok && !bytes.Equal(dd.MemberPub, dr.MemberPub) {
		return fmt.Errorf("identity: member %x cannot revoke device %x held by member %x",
			dr.MemberPub, dr.DevicePub, dd.MemberPub)
	}
	l.revoked[key] = dr
	delete(l.delegations, key)
	return nil
}

// Devices lists the currently-valid device delegations under memberPub, for the
// "your devices" settings surface. Revoked devices are absent by construction.
func (l *DeviceLog) Devices(memberPub PubKey) []*DeviceDelegation {
	l.mu.RLock()
	defer l.mu.RUnlock()
	var out []*DeviceDelegation
	for _, dd := range l.delegations {
		if bytes.Equal(dd.MemberPub, memberPub) {
			out = append(out, dd)
		}
	}
	return out
}

// --- Resolver -------------------------------------------------------------

// SessionDelegation implements Resolver.
func (l *DeviceLog) SessionDelegation(sessionPub []byte) (*SessionDelegation, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	sd, ok := l.sessions[hex.EncodeToString(sessionPub)]
	return sd, ok
}

// DeviceDelegation implements Resolver.
func (l *DeviceLog) DeviceDelegation(devicePub []byte) (*DeviceDelegation, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	dd, ok := l.delegations[hex.EncodeToString(devicePub)]
	return dd, ok
}

// DeviceRevoked implements Resolver.
func (l *DeviceLog) DeviceRevoked(devicePub []byte) bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	_, ok := l.revoked[hex.EncodeToString(devicePub)]
	return ok
}

// Attestation implements Resolver.
func (l *DeviceLog) Attestation(memberPub []byte) (*IdentityAttestation, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	att, ok := l.attestations[hex.EncodeToString(memberPub)]
	return att, ok
}

var _ Resolver = (*DeviceLog)(nil)

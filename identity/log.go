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

// AddDelegation verifies a device delegation against the parent that signed it
// and stores it. Refused if the device key is already revoked.
func (l *DeviceLog) AddDelegation(dd *DeviceDelegation) error {
	if dd == nil {
		return fmt.Errorf("identity: nil delegation")
	}
	if !verifySig(dd, dd.ParentPub, dd.Sig) {
		return fmt.Errorf("delegation for %x: %w", dd.DevicePub, ErrBadSignature)
	}
	if bytes.Equal(dd.DevicePub, dd.ParentPub) {
		return fmt.Errorf("identity: device %x cannot delegate itself: %w",
			dd.DevicePub, ErrChainCycle)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	key := hex.EncodeToString(dd.DevicePub)
	if _, gone := l.revoked[key]; gone {
		return fmt.Errorf("device %x: %w (revoked keys cannot be re-paired)",
			dd.DevicePub, ErrRevoked)
	}
	// A device has exactly ONE parent. This is what keeps the structure a tree
	// rather than a graph — load-bearing now that the walk is recursive, since a
	// second parent is how a stolen delegation would be laundered into a
	// different identity, and how a cycle would get in.
	if prev, ok := l.delegations[key]; ok && !bytes.Equal(prev.ParentPub, dd.ParentPub) {
		return fmt.Errorf("identity: device %x already delegated by %x",
			dd.DevicePub, prev.ParentPub)
	}
	// Reject a delegation that would close a loop: the proposed parent must not
	// already sit below the device it is being attached under.
	if l.descendsFromLocked(dd.ParentPub, dd.DevicePub) {
		return fmt.Errorf("identity: %x already descends from %x: %w",
			dd.ParentPub, dd.DevicePub, ErrChainCycle)
	}
	l.delegations[key] = dd
	return nil
}

// descendsFromLocked reports whether pub sits anywhere below ancestor in the
// delegation tree. Caller holds the lock.
func (l *DeviceLog) descendsFromLocked(pub, ancestor []byte) bool {
	cur := pub
	for range MaxChainDepth {
		if bytes.Equal(cur, ancestor) {
			return true
		}
		dd, ok := l.delegations[hex.EncodeToString(cur)]
		if !ok {
			return false
		}
		cur = dd.ParentPub
	}
	return false
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

// AddRevoke verifies a revocation and applies it. The revoker must be an
// ANCESTOR of the revoked device — its parent, a grandparent, or the member root
// at the top — so a device can retire what it paired but not what paired it.
// That check is repeated in VerifySender, which cannot assume its Resolver is
// this careful: the sqlite log is a content-addressed set that accepts any
// well-signed object under whatever subject it names.
//
// A revoke for an unknown device is accepted and remembered (tombstoned), so a
// delegation that arrives later is still refused. Authority cannot be checked in
// that case — there is no chain to place the revoker on — which is why
// VerifySender re-checks once the delegation is known.
func (l *DeviceLog) AddRevoke(dr *DeviceRevoke) error {
	if dr == nil {
		return fmt.Errorf("identity: nil revoke")
	}
	if !verifySig(dr, dr.RevokerPub, dr.Sig) {
		return fmt.Errorf("revoke for %x: %w", dr.DevicePub, ErrBadSignature)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	key := hex.EncodeToString(dr.DevicePub)
	if _, known := l.delegations[key]; known {
		// The revoker must sit strictly ABOVE the target: walk up from the
		// target's parent, so naming the target itself does not qualify.
		parent := l.delegations[key].ParentPub
		if !l.descendsFromLocked(parent, dr.RevokerPub) && !bytes.Equal(parent, dr.RevokerPub) {
			return fmt.Errorf("identity: %x cannot revoke device %x — not an ancestor of it",
				dr.RevokerPub, dr.DevicePub)
		}
	}
	l.revoked[key] = dr
	return nil
}

// Subtree returns devicePub together with every device delegated below it,
// which is exactly the set a revocation of devicePub takes down. The revoke UI
// must show this before confirming — the cascade is otherwise invisible until
// someone's other device stops working — and key rotation must exclude ALL of
// it, since a descendant still physically holds the keys it was wrapped.
func (l *DeviceLog) Subtree(devicePub PubKey) []PubKey {
	l.mu.RLock()
	defer l.mu.RUnlock()

	out := []PubKey{append(PubKey(nil), devicePub...)}
	// Repeated sweeps rather than recursion: the map is unordered, so a child
	// may be visited before its parent is known to be in the set.
	for range MaxChainDepth {
		grew := false
		for _, dd := range l.delegations {
			if containsPub(out, dd.DevicePub) {
				continue
			}
			if containsPub(out, dd.ParentPub) {
				out = append(out, append(PubKey(nil), dd.DevicePub...))
				grew = true
			}
		}
		if !grew {
			break
		}
	}
	return out
}

func containsPub(set []PubKey, pub []byte) bool {
	for _, p := range set {
		if bytes.Equal(p, pub) {
			return true
		}
	}
	return false
}

// Devices lists the currently-valid device delegations in memberPub's tree, at
// any depth — a tablet paired from a phone belongs to the member just as much as
// the laptop the member root signed directly.
//
// A device is excluded if it OR any ancestor is revoked: the cascade applies
// here exactly as it does in the chain walk, so this never lists a device that
// has in fact stopped working. Revoked delegations are filtered rather than
// deleted, because the walk needs them to tell "revoked" from "unknown device".
func (l *DeviceLog) Devices(memberPub PubKey) []*DeviceDelegation {
	l.mu.RLock()
	defer l.mu.RUnlock()
	var out []*DeviceDelegation
	for _, dd := range l.delegations {
		if !l.descendsFromLocked(dd.DevicePub, memberPub) {
			continue
		}
		if l.revokedAtOrAboveLocked(dd.DevicePub, memberPub) {
			continue
		}
		out = append(out, dd)
	}
	return out
}

// revokedAtOrAboveLocked reports whether devicePub or anything between it and
// memberPub has been revoked. Caller holds the lock.
func (l *DeviceLog) revokedAtOrAboveLocked(devicePub, memberPub []byte) bool {
	cur := devicePub
	for range MaxChainDepth {
		if bytes.Equal(cur, memberPub) {
			return false
		}
		key := hex.EncodeToString(cur)
		if _, gone := l.revoked[key]; gone {
			return true
		}
		dd, ok := l.delegations[key]
		if !ok {
			return false
		}
		cur = dd.ParentPub
	}
	return false
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

// DeviceRevokeFor implements Resolver.
func (l *DeviceLog) DeviceRevokeFor(devicePub []byte) (*DeviceRevoke, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	dr, ok := l.revoked[hex.EncodeToString(devicePub)]
	return dr, ok
}

// Attestation implements Resolver.
func (l *DeviceLog) Attestation(memberPub []byte) (*IdentityAttestation, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	att, ok := l.attestations[hex.EncodeToString(memberPub)]
	return att, ok
}

var _ Resolver = (*DeviceLog)(nil)

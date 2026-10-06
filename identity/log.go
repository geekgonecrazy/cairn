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

	attestations map[string][]*IdentityAttestation // member pubkey hex → every attestation published
	delegations  map[string]*DeviceDelegation      // device pubkey hex → delegation
	sessions     map[string]*SessionDelegation     // session pubkey hex → delegation
	revoked      map[string]*DeviceRevoke          // device pubkey hex → revoke
	vouches      map[string][]*AgentDelegation     // agent pubkey hex → every vouch
	withdraws    map[string][]*VouchWithdraw        // agent pubkey hex → every withdrawal
}

// NewDeviceLog returns an empty log.
func NewDeviceLog() *DeviceLog {
	return &DeviceLog{
		attestations: map[string][]*IdentityAttestation{},
		delegations:  map[string]*DeviceDelegation{},
		sessions:     map[string]*SessionDelegation{},
		revoked:      map[string]*DeviceRevoke{},
		vouches:      map[string][]*AgentDelegation{},
		withdraws:    map[string][]*VouchWithdraw{},
	}
}

// AddAttestation verifies a member's self-attestation against the key it names
// (the signer) and stores it. A valid signature proves the profile is authored by
// that key's holder; whether to trust the key is a separate edge decision.
//
// A member may publish many attestations over time (rename, transfer) — all are
// kept, and readers select the current one with CurrentAttestation (latest
// issued_at wins, kind earliest-wins). Rejecting a conflicting kind at insert
// would be order-dependent across replicas that learn the same set in a
// different order, so the rule lives in selection, not admission.
func (l *DeviceLog) AddAttestation(att *IdentityAttestation) error {
	if att == nil {
		return fmt.Errorf("identity: nil attestation")
	}
	if len(att.Pubkey) != ed25519.PublicKeySize {
		return fmt.Errorf("identity: attestation pubkey must be %d bytes", ed25519.PublicKeySize)
	}
	if !verifySig(att, att.Pubkey, att.Sig) {
		return fmt.Errorf("attestation for %x: %w", att.Pubkey, ErrBadSignature)
	}

	h, err := Hash(att)
	if err != nil {
		return fmt.Errorf("identity: hash attestation: %w", err)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	key := hex.EncodeToString(att.Pubkey)
	for _, prev := range l.attestations[key] {
		if ph, err := Hash(prev); err == nil && ph == h {
			return nil // already filed; the log is a set
		}
	}
	l.attestations[key] = append(l.attestations[key], att)
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

// AddRevoke verifies a revocation and applies it. The revoker must be an// ANCESTOR of the revoked device — its parent, a grandparent, or the member root
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

// AddAgentDelegation verifies a vouch against the delegator device that signed
// it and files it under the agent. Many devices may vouch for one agent —
// that redundancy is the point — so this is a set per agent, not a single
// slot. A vouch whose delegator belongs to someone else's tree, names the
// wrong operator, or is withdrawn is still STORED (the log files well-signed
// objects); VerifySender filters it out of the proof.
func (l *DeviceLog) AddAgentDelegation(d *AgentDelegation) error {
	if d == nil {
		return fmt.Errorf("identity: nil agent delegation")
	}
	if len(d.AgentPub) != ed25519.PublicKeySize || len(d.DelegatorPub) != ed25519.PublicKeySize {
		return fmt.Errorf("identity: agent delegation pubs must be %d bytes", ed25519.PublicKeySize)
	}
	if len(d.OperatorPub) != ed25519.PublicKeySize {
		return fmt.Errorf("identity: agent delegation must name a 32-byte operator")
	}
	if bytes.Equal(d.AgentPub, d.DelegatorPub) {
		return fmt.Errorf("identity: a key cannot vouch itself as an agent")
	}
	if !verifySig(d, d.DelegatorPub, d.Sig) {
		return fmt.Errorf("agent delegation for %x: %w", d.AgentPub, ErrBadSignature)
	}

	h, err := Hash(d)
	if err != nil {
		return fmt.Errorf("identity: hash agent delegation: %w", err)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	key := hex.EncodeToString(d.AgentPub)
	for _, prev := range l.vouches[key] {
		if ph, err := Hash(prev); err == nil && ph == h {
			return nil // already filed; the log is a set
		}
	}
	l.vouches[key] = append(l.vouches[key], d)
	return nil
}

// AddVouchWithdraw verifies a withdrawal against the delegator withdrawing its
// own vouch and files it. Only self-withdrawal is stored — a withdraw signed
// by anyone else names a signer that is not its subject, and filing it would
// let a stranger manufacture "evidence" against someone else's vouch.
func (l *DeviceLog) AddVouchWithdraw(w *VouchWithdraw) error {
	if w == nil {
		return fmt.Errorf("identity: nil vouch withdrawal")
	}
	if len(w.AgentPub) != ed25519.PublicKeySize || len(w.DelegatorPub) != ed25519.PublicKeySize {
		return fmt.Errorf("identity: vouch withdrawal pubs must be %d bytes", ed25519.PublicKeySize)
	}
	if !verifySig(w, w.DelegatorPub, w.Sig) {
		return fmt.Errorf("vouch withdrawal for %x: %w", w.AgentPub, ErrBadSignature)
	}

	h, err := Hash(w)
	if err != nil {
		return fmt.Errorf("identity: hash vouch withdrawal: %w", err)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	key := hex.EncodeToString(w.AgentPub)
	for _, prev := range l.withdraws[key] {
		if ph, err := Hash(prev); err == nil && ph == h {
			return nil // already filed; the log is a set
		}
	}
	l.withdraws[key] = append(l.withdraws[key], w)
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

// Attestation implements Resolver, selecting the member's CURRENT attestation
// out of everything it published (CurrentAttestation) — never last-write-wins.
func (l *DeviceLog) Attestation(memberPub []byte) (*IdentityAttestation, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	att := CurrentAttestation(l.attestations[hex.EncodeToString(memberPub)])
	if att == nil {
		return nil, false
	}
	return att, true
}

// AgentDelegations implements Resolver.
func (l *DeviceLog) AgentDelegations(agentPub []byte) []*AgentDelegation {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := append([]*AgentDelegation(nil), l.vouches[hex.EncodeToString(agentPub)]...)
	return out
}

// VouchWithdraws implements Resolver.
func (l *DeviceLog) VouchWithdraws(agentPub []byte) []*VouchWithdraw {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := append([]*VouchWithdraw(nil), l.withdraws[hex.EncodeToString(agentPub)]...)
	return out
}

var _ Resolver = (*DeviceLog)(nil)

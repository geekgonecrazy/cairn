package identity

import (
	"bytes"
	"errors"
	"fmt"
)

// Resolver supplies the identity-log objects a chain walk needs, keyed by the
// pubkey each object authorizes. The store implements this over its persisted
// identity log; tests use an in-memory version. A missing object means the
// verifier must fetch it (GetIdentityObject) before it can decide.
type Resolver interface {
	// SessionDelegation returns the delegation naming sessionPub as SessionPub.
	SessionDelegation(sessionPub []byte) (*SessionDelegation, bool)
	// DeviceDelegation returns the delegation naming devicePub as DevicePub.
	// Absent for a member root, which is attested rather than delegated — that
	// is how the walk knows it has reached the top of a device tree.
	DeviceDelegation(devicePub []byte) (*DeviceDelegation, bool)
	// DeviceRevokeFor returns the DeviceRevoke naming devicePub, if one is
	// known. It returns the OBJECT rather than a boolean because a revocation
	// is only binding when it was signed by the member root that holds the
	// device — a caller handed a bare "revoked: true" has no way to check that,
	// and a store that files revokes by subject alone would let anyone revoke
	// anyone. VerifySender does the checking; see the revocation step there.
	DeviceRevokeFor(devicePub []byte) (*DeviceRevoke, bool)
	// Attestation returns the household attestation for a member-root pubkey.
	Attestation(memberPub []byte) (*IdentityAttestation, bool)
}

// Resolved is the identity a sender's key ultimately belongs to: the member root
// its device chain terminates at, plus that member's self-asserted profile. The
// profile fields come from the member's self-attestation, not from the sender's
// per-event claims.
type Resolved struct {
	MemberPub   []byte // the member root the sending key chains up to
	Kind        Kind
	OperatedBy  []byte // for agents: the operating human member root
	DisplayName string
}

// Sentinel errors from VerifySender. Callers distinguish ErrUnknownObject
// (fetch the missing link and retry) from the terminal rejections.
var (
	ErrUnknownObject = errors.New("identity: chain link not found (fetch and retry)")
	ErrBadSignature  = errors.New("identity: signature does not verify")
	ErrExpired       = errors.New("identity: delegation expired")
	ErrRevoked       = errors.New("identity: device revoked")
	ErrChainTooDeep  = errors.New("identity: delegation chain exceeds the depth limit")
	ErrChainCycle    = errors.New("identity: delegation chain contains a cycle")
)

// MaxChainDepth bounds the device→device walk. Devices delegate devices, so the
// chain is no longer fixed-length and an unbounded walk would be a denial of
// service on every verifier. Eight is far past any real pairing history (phone
// from laptop, tablet from phone) and cheap to check.
const MaxChainDepth = 8

// VerifySender walks senderPub (a device OR session key) up to the member root it
// belongs to, checking every signature, expiry, and revocation along the way. now
// is unix-ms wall-clock. On success it returns the resolved identity; on a missing
// link it returns ErrUnknownObject wrapped with the hex of the pubkey that needs
// fetching.
//
// Chain: session key → session_delegation → device key → device_delegation →
// … → device key → device_delegation → member root → self-attestation. A device
// key that signs directly (no session tier, e.g. native/agent) skips the session
// hop.
//
// This RESOLVES identity; it does not decide trust. In the v2 model there is no
// household root and no trusted-root set — a valid chain proves "this key belongs
// to member M with this self-asserted profile", and whether to trust M is an edge
// decision (pairing, or a room that admitted M). Revocation is still enforced.
//
// The device segment is a WALK, not one hop: devices pair devices, so a tablet
// admitted from a phone chains tablet → phone → laptop → member root. Bounded by
// MaxChainDepth and guarded against cycles.
func VerifySender(senderPub []byte, r Resolver, now int64) (*Resolved, error) {
	devicePub := senderPub

	// Step 1 (browser only): resolve a session key to its device key.
	if sd, ok := r.SessionDelegation(senderPub); ok {
		if !verifySig(sd, sd.DevicePub, sd.Sig) {
			return nil, fmt.Errorf("session_delegation: %w", ErrBadSignature)
		}
		if sd.ExpiresAt != 0 && now > sd.ExpiresAt {
			return nil, fmt.Errorf("session_delegation: %w", ErrExpired)
		}
		devicePub = sd.DevicePub
	}

	// Step 2: walk the device tree up to the member root. Each delegation names
	// its parent, which is another device key until we reach the member root at
	// the top — so this is a loop, not a single hop.
	chain, memberPub, err := walkDevices(devicePub, r, now)
	if err != nil {
		return nil, err
	}

	// Step 3: revocation, checked at EVERY hop. This is what makes revocation
	// cascade: a revoked device invalidates everything paired from it, because
	// a descendant's chain runs through it. No descendant has to be named.
	if err := checkRevocations(chain, memberPub, r); err != nil {
		return nil, err
	}

	// Step 4: the member root's self-attestation carries its profile (kind, name,
	// operated_by), signed by the member key itself.
	att, ok := r.Attestation(memberPub)
	if !ok {
		return nil, fmt.Errorf("%w: member %x", ErrUnknownObject, memberPub)
	}
	if !bytes.Equal(att.Pubkey, memberPub) {
		return nil, fmt.Errorf("attestation: pubkey mismatch: %w", ErrBadSignature)
	}
	if !verifySig(att, att.Pubkey, att.Sig) {
		return nil, fmt.Errorf("identity_attestation: %w", ErrBadSignature)
	}

	return &Resolved{
		MemberPub:   append([]byte(nil), att.Pubkey...),
		Kind:        att.Kind,
		OperatedBy:  append([]byte(nil), att.OperatedBy...),
		DisplayName: att.DisplayName,
	}, nil
}

// walkDevices climbs the delegation tree from devicePub to the member root at
// its top, verifying each delegation's signature and expiry. It returns the
// chain leaf-first and the member root the chain terminates at.
//
// The walk stops at the first key with no delegation of its own — that key IS
// the member root, since a member root is attested rather than delegated. A
// device whose own delegation is missing yields ErrUnknownObject (fetch and
// retry), never a silently shorter chain.
func walkDevices(devicePub []byte, r Resolver, now int64) ([]*DeviceDelegation, []byte, error) {
	var chain []*DeviceDelegation
	seen := map[string]bool{}
	cur := devicePub

	for {
		if seen[string(cur)] {
			return nil, nil, fmt.Errorf("device %x: %w", cur, ErrChainCycle)
		}
		seen[string(cur)] = true

		dd, ok := r.DeviceDelegation(cur)
		if !ok {
			// No delegation: cur is the member root (or an unknown key, which
			// the attestation lookup in step 4 will reject).
			if len(chain) == 0 {
				return nil, nil, fmt.Errorf("%w: device %x", ErrUnknownObject, cur)
			}
			return chain, cur, nil
		}
		if !bytes.Equal(dd.DevicePub, cur) {
			return nil, nil, fmt.Errorf("device_delegation: subject mismatch: %w", ErrBadSignature)
		}
		if !verifySig(dd, dd.ParentPub, dd.Sig) {
			return nil, nil, fmt.Errorf("device_delegation: %w", ErrBadSignature)
		}
		if dd.ExpiresAt != 0 && now > dd.ExpiresAt {
			return nil, nil, fmt.Errorf("device_delegation: %w", ErrExpired)
		}

		chain = append(chain, dd)
		if len(chain) > MaxChainDepth {
			return nil, nil, fmt.Errorf("device %x: %w", devicePub, ErrChainTooDeep)
		}
		cur = dd.ParentPub
	}
}

// checkRevocations rejects the chain if any device on it has been validly
// revoked. A revoke binds only when signed by an ANCESTOR of its target: the
// identity log is an open set that any key can file well-signed objects into,
// so an unauthenticated revoke would be a permanent household-wide denial of
// service (revoked keys can never be re-paired). An unauthorized revoke is not
// evidence of anything and is ignored rather than treated as a weaker signal.
//
// chain is leaf-first, so everything ABOVE index i — plus the member root — is
// an ancestor of chain[i].
func checkRevocations(chain []*DeviceDelegation, memberPub []byte, r Resolver) error {
	for i, dd := range chain {
		dr, ok := r.DeviceRevokeFor(dd.DevicePub)
		if !ok {
			continue
		}
		if !bytes.Equal(dr.DevicePub, dd.DevicePub) {
			continue // filed under the wrong subject; says nothing about this device
		}
		if !verifySig(dr, dr.RevokerPub, dr.Sig) {
			continue // forged, or tampered with in transit
		}
		if !isAncestor(dr.RevokerPub, chain[i+1:], memberPub) {
			continue // a peer or a stranger trying to revoke someone else's device
		}
		return fmt.Errorf("device %x revoked by %x: %w", dd.DevicePub, dr.RevokerPub, ErrRevoked)
	}
	return nil
}

// isAncestor reports whether pub is one of the delegations above a device, or
// the member root at the top of its tree.
func isAncestor(pub []byte, above []*DeviceDelegation, memberPub []byte) bool {
	if bytes.Equal(pub, memberPub) {
		return true
	}
	for _, dd := range above {
		if bytes.Equal(pub, dd.DevicePub) {
			return true
		}
	}
	return false
}

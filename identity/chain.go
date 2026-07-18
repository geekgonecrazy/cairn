package identity

import (
	"bytes"
	"crypto/ed25519"
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
	DeviceDelegation(devicePub []byte) (*DeviceDelegation, bool)
	// DeviceRevoked reports whether devicePub has a matching DeviceRevoke.
	DeviceRevoked(devicePub []byte) bool
	// Attestation returns the household attestation for a member-root pubkey.
	Attestation(memberPub []byte) (*IdentityAttestation, bool)
}

// Resolved is the attested identity a sender's key ultimately belongs to. The
// fields come from the household attestation, not from the sender's claims.
type Resolved struct {
	MemberPub   []byte // the member root the sending key chains up to
	Kind        Kind
	Origin      []byte // household root pubkey (the household id)
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
	ErrUntrustedRoot = errors.New("identity: chain does not terminate at a trusted root")
)

// VerifySender walks senderPub (a device OR session key) back to a household
// root in trustedRoots, checking every signature, expiry, and revocation along
// the way. now is unix-ms wall-clock. On success it returns the attested
// identity; on a missing link it returns ErrUnknownObject wrapped with the hex
// of the pubkey that needs fetching.
//
// Chain: session key → session_delegation → device key → device_delegation →
// member root → identity_attestation (by a trusted household root). A device
// key that signs directly (no session tier, e.g. native/agent) skips step one.
func VerifySender(senderPub []byte, r Resolver, trustedRoots [][]byte, now int64) (*Resolved, error) {
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

	// Step 2: device key → member root via device_delegation.
	dd, ok := r.DeviceDelegation(devicePub)
	if !ok {
		return nil, fmt.Errorf("%w: device %x", ErrUnknownObject, devicePub)
	}
	if !verifySig(dd, dd.MemberPub, dd.Sig) {
		return nil, fmt.Errorf("device_delegation: %w", ErrBadSignature)
	}
	if dd.ExpiresAt != 0 && now > dd.ExpiresAt {
		return nil, fmt.Errorf("device_delegation: %w", ErrExpired)
	}
	if r.DeviceRevoked(devicePub) {
		return nil, fmt.Errorf("device %x: %w", devicePub, ErrRevoked)
	}

	// Step 3: member root → household root via identity_attestation.
	att, ok := r.Attestation(dd.MemberPub)
	if !ok {
		return nil, fmt.Errorf("%w: member %x", ErrUnknownObject, dd.MemberPub)
	}
	if !bytes.Equal(att.Pubkey, dd.MemberPub) {
		return nil, fmt.Errorf("attestation: pubkey mismatch: %w", ErrBadSignature)
	}
	if !verifySig(att, att.Origin, att.Sig) {
		return nil, fmt.Errorf("identity_attestation: %w", ErrBadSignature)
	}
	if !trusts(trustedRoots, att.Origin) {
		return nil, fmt.Errorf("origin %x: %w", att.Origin, ErrUntrustedRoot)
	}

	return &Resolved{
		MemberPub:   append([]byte(nil), att.Pubkey...),
		Kind:        att.Kind,
		Origin:      append([]byte(nil), att.Origin...),
		OperatedBy:  append([]byte(nil), att.OperatedBy...),
		DisplayName: att.DisplayName,
	}, nil
}

func trusts(roots [][]byte, origin []byte) bool {
	if len(origin) != ed25519.PublicKeySize {
		return false
	}
	for _, root := range roots {
		if bytes.Equal(root, origin) {
			return true
		}
	}
	return false
}

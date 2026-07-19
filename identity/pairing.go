package identity

// QR device pairing.
//
// A new device generates its own keypair, shows its public key as a QR payload,
// and an already-trusted device belonging to the SAME member root signs a
// DeviceDelegation for it. The new device's private key never leaves it and the
// member root's private key never leaves the trusted device — the QR carries a
// public key in one direction and a signed delegation back in the other.
//
// The pairing payload is intentionally tiny and versioned: it has to survive
// being rendered as a QR code on a phone screen and read by a camera in bad
// light. Room keys are NOT part of pairing; they are handed over separately by
// the existing member_add / room_key_rotate HPKE path (Phase 1), so a pairing
// QR photographed by a bystander leaks a public key and nothing else.

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"strings"
)

// PairingVersion is the wire version of the QR payload. Bump on any field
// change; unknown versions are refused rather than best-effort parsed.
const PairingVersion = 1

// pairingPrefix namespaces the QR payload so a scanner can tell a Cairn pairing
// code from any other QR it might be pointed at.
const pairingPrefix = "cairn:pair:"

// PairingRequest is what a new, unpaired device displays as a QR code. It
// asserts nothing — the device pubkey is unsigned, because the device has no
// standing in the household yet. The human's act of scanning it on a trusted
// device IS the authorization; that is why the trusted device must show the
// fingerprint for visual comparison before signing (see Fingerprint).
type PairingRequest struct {
	Version   int
	DevicePub PubKey
	// Label is the new device's self-reported name ("Sam's iPhone"). Advisory
	// only: it is not attested and must be rendered as untrusted input.
	Label string
}

// NewPairingRequest builds the payload a fresh device shows during pairing.
func NewPairingRequest(devicePub PubKey, label string) (*PairingRequest, error) {
	if len(devicePub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: device pubkey must be %d bytes, got %d",
			ed25519.PublicKeySize, len(devicePub))
	}
	if strings.ContainsAny(label, ":\n") {
		return nil, fmt.Errorf("identity: pairing label must not contain ':' or newlines")
	}
	return &PairingRequest{Version: PairingVersion, DevicePub: devicePub, Label: label}, nil
}

// Encode renders the request as the QR payload string:
//
//	cairn:pair:1:<base64url devicePub>:<label>
//
// Base64url (unpadded) keeps the payload in the QR alphanumeric-adjacent range
// and short enough for a low-density code that scans reliably.
func (p *PairingRequest) Encode() string {
	return fmt.Sprintf("%s%d:%s:%s",
		pairingPrefix, p.Version,
		base64.RawURLEncoding.EncodeToString(p.DevicePub),
		p.Label)
}

// ParsePairingRequest parses a scanned QR payload. It validates structure only:
// a well-formed request is still completely untrusted until a human approves it.
func ParsePairingRequest(s string) (*PairingRequest, error) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(s), pairingPrefix)
	if !ok {
		return nil, fmt.Errorf("identity: not a Cairn pairing code")
	}
	// SplitN with 3: the label is last and may itself be empty.
	parts := strings.SplitN(rest, ":", 3)
	if len(parts) != 3 {
		return nil, fmt.Errorf("identity: malformed pairing code")
	}
	var version int
	if _, err := fmt.Sscanf(parts[0], "%d", &version); err != nil {
		return nil, fmt.Errorf("identity: malformed pairing version")
	}
	if version != PairingVersion {
		return nil, fmt.Errorf("identity: unsupported pairing version %d (this build speaks %d)",
			version, PairingVersion)
	}
	pub, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("identity: malformed pairing key: %w", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: pairing key must be %d bytes, got %d",
			ed25519.PublicKeySize, len(pub))
	}
	return &PairingRequest{Version: version, DevicePub: pub, Label: parts[2]}, nil
}

// Fingerprint renders a device pubkey as short, human-comparable groups. The
// pairing UI shows this on BOTH screens so the human can confirm the trusted
// device is signing the key the new device actually holds, rather than one
// substituted in between.
//
// This is a comparison aid, not a security boundary: it is a truncation of the
// key, so treat a match as "same key" only in combination with the human having
// both screens physically in front of them.
func Fingerprint(pub PubKey) string {
	const groups = 4
	if len(pub) < groups*2 {
		return ""
	}
	out := make([]string, groups)
	for i := range groups {
		out[i] = fmt.Sprintf("%02x%02x", pub[i*2], pub[i*2+1])
	}
	return strings.Join(out, "-")
}

// ApprovePairing issues the DeviceDelegation that admits devicePub under the
// PARENT that signs it. Called on the already-trusted device, after the human
// has compared fingerprints.
//
// The parent is a member root only for a member's FIRST device — that signature
// is made from the member's recovery words and the root is then put away. Every
// later device is paired from an existing device, whose key signs as parent, so
// no live copy of the member root is needed to add a device (and a stolen device
// therefore cannot mint itself a fresh sibling).
//
// expiresAt is unix-ms; pass 0 for a non-expiring delegation. Daily-driver
// devices are typically non-expiring and revoked explicitly (see DeviceRevoke);
// prefer an expiry for devices you expect to be temporary.
func ApprovePairing(
	req *PairingRequest,
	parentPub PubKey,
	parentPriv ed25519.PrivateKey,
	issuedAt, expiresAt int64,
) (*DeviceDelegation, error) {
	if req == nil {
		return nil, fmt.Errorf("identity: nil pairing request")
	}
	if len(req.DevicePub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: pairing request has no valid device key")
	}
	if len(parentPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: parent pubkey must be %d bytes, got %d",
			ed25519.PublicKeySize, len(parentPub))
	}
	if bytes.Equal(req.DevicePub, parentPub) {
		return nil, fmt.Errorf("identity: a device cannot delegate itself")
	}
	if expiresAt != 0 && expiresAt <= issuedAt {
		return nil, fmt.Errorf("identity: delegation expires_at must be after issued_at")
	}

	dd := &DeviceDelegation{
		DevicePub: append([]byte(nil), req.DevicePub...),
		ParentPub: append([]byte(nil), parentPub...),
		IssuedAt:  issuedAt,
		ExpiresAt: expiresAt,
	}
	if err := Sign(dd, parentPriv); err != nil {
		return nil, fmt.Errorf("identity: sign device delegation: %w", err)
	}
	return dd, nil
}

// RevokeDevice mints the DeviceRevoke that terminates devicePub's delegation,
// signed by revokerPub. The revoker must be an ANCESTOR of devicePub — its
// parent, a grandparent, or the member root — which verifiers enforce; this
// function only mints, so a caller that signs with the wrong key produces an
// object every verifier will ignore.
//
// Revoking a device also takes down every device paired FROM it, since their
// chains run through it (see DeviceLog.Subtree, which the UI must show before
// confirming). Revocation is an assertion that takes effect for any verifier
// that has seen the object, which is why the identity log must propagate it.
func RevokeDevice(
	devicePub, revokerPub PubKey,
	revokerPriv ed25519.PrivateKey,
	revokedAt int64,
) (*DeviceRevoke, error) {
	if len(devicePub) != ed25519.PublicKeySize || len(revokerPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: device and revoker pubkeys must be %d bytes",
			ed25519.PublicKeySize)
	}
	if bytes.Equal(devicePub, revokerPub) {
		return nil, fmt.Errorf("identity: a device cannot revoke itself " +
			"(a revoke binds only from an ancestor)")
	}
	dr := &DeviceRevoke{
		DevicePub:  append([]byte(nil), devicePub...),
		RevokerPub: append([]byte(nil), revokerPub...),
		RevokedAt:  revokedAt,
	}
	if err := Sign(dr, revokerPriv); err != nil {
		return nil, fmt.Errorf("identity: sign device revoke: %w", err)
	}
	return dr, nil
}

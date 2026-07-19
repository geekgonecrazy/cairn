package identity

// Join codes and invite blobs — the two artifacts that pass between a newcomer
// and whoever holds the household's words.
//
// These formats existed only in the browser until founding and attestation moved
// to the CLI. They are byte-compatible with webapp/src/lib/identity.ts, and
// identity/conformance_test.go pins that: a join code produced in a browser must
// parse here, and an invite minted here must verify there.
//
// Neither artifact is secret. A join code carries a public key and a
// SELF-DECLARED name; an invite carries a signed attestation anyone may read.
// What matters is that the newcomer checks the household fingerprint out of
// band — an attestation's origin is self-declared, so a stranger's household
// verifies its own signature perfectly.

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/fxamacker/cbor/v2"
)

const (
	joinPrefix   = "cairn:join:"
	invitePrefix = "cairn:att:"
)

// JoinRequest is what a newcomer hands to an existing member: their member root
// pubkey plus the name they would like to be known by. The name is unattested
// until the household signs it, so render it as untrusted input.
type JoinRequest struct {
	Version     int
	MemberPub   PubKey
	DisplayName string
}

// NewJoinRequest builds the code a newcomer publishes.
func NewJoinRequest(memberPub PubKey, displayName string) (*JoinRequest, error) {
	if len(memberPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: member pubkey must be %d bytes, got %d",
			ed25519.PublicKeySize, len(memberPub))
	}
	if strings.ContainsAny(displayName, ":\n") {
		return nil, fmt.Errorf("identity: display name must not contain ':' or newlines")
	}
	return &JoinRequest{Version: PairingVersion, MemberPub: memberPub, DisplayName: displayName}, nil
}

// Encode renders the join code: cairn:join:1:<base64url memberPub>:<name>
func (j *JoinRequest) Encode() string {
	return fmt.Sprintf("%s%d:%s:%s",
		joinPrefix, j.Version,
		base64.RawURLEncoding.EncodeToString(j.MemberPub),
		j.DisplayName)
}

// ParseJoinRequest parses a join code. Structure only — a well-formed code is
// still an unattested stranger until someone signs an attestation for it.
func ParseJoinRequest(s string) (*JoinRequest, error) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(s), joinPrefix)
	if !ok {
		return nil, fmt.Errorf("identity: not a Cairn join code")
	}
	parts := strings.SplitN(rest, ":", 3)
	if len(parts) != 3 {
		return nil, fmt.Errorf("identity: malformed join code")
	}
	var version int
	if _, err := fmt.Sscanf(parts[0], "%d", &version); err != nil {
		return nil, fmt.Errorf("identity: malformed join code version")
	}
	if version != PairingVersion {
		return nil, fmt.Errorf("identity: unsupported join code version %d (this build speaks %d)",
			version, PairingVersion)
	}
	pub, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("identity: malformed join key: %w", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: join key must be %d bytes, got %d",
			ed25519.PublicKeySize, len(pub))
	}
	return &JoinRequest{Version: version, MemberPub: pub, DisplayName: parts[2]}, nil
}

// EncodeInvite serializes a signed attestation for hand-carrying back to the
// newcomer: cairn:att:1:<base64url CBOR>.
func EncodeInvite(att *IdentityAttestation) (string, error) {
	if att == nil {
		return "", fmt.Errorf("identity: nil attestation")
	}
	// Marshal, NOT a hand-built map through cbor.Marshal: the package encoder is
	// canonical (length-first key ordering), which is what the browser writes.
	// A plain cbor.Marshal(map) sorts keys lexicographically instead, producing
	// a blob that still decodes and still verifies — the signature covers the
	// fields, not this envelope — but is byte-different from the browser's. That
	// silent near-miss is exactly the kind of drift conformance exists to catch.
	payload, err := Marshal(att)
	if err != nil {
		return "", fmt.Errorf("identity: encode invite: %w", err)
	}
	return fmt.Sprintf("%s%d:%s",
		invitePrefix, PairingVersion, base64.RawURLEncoding.EncodeToString(payload)), nil
}

// ParseInvite parses AND VERIFIES an invite blob. Verification is not optional:
// the blob arrives by copy-paste, so a bad signature here is the only thing
// between a newcomer and a forged membership.
//
// A valid signature proves only that SOME household signed it — origin is
// self-declared. The caller must still show the household fingerprint for
// out-of-band comparison.
func ParseInvite(s string) (*IdentityAttestation, error) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(s), invitePrefix)
	if !ok {
		return nil, fmt.Errorf("identity: not a Cairn invite")
	}
	parts := strings.SplitN(rest, ":", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("identity: malformed invite")
	}
	var version int
	if _, err := fmt.Sscanf(parts[0], "%d", &version); err != nil || version != PairingVersion {
		return nil, fmt.Errorf("identity: unsupported invite version")
	}
	blob, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("identity: malformed invite (truncated when copied?): %w", err)
	}
	var att IdentityAttestation
	if err := cbor.Unmarshal(blob, &att); err != nil {
		return nil, fmt.Errorf("identity: malformed invite: %w", err)
	}
	if len(att.Pubkey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: invite is missing a valid member key")
	}
	if !VerifyAttestation(&att) {
		return nil, fmt.Errorf("identity: invite is not correctly signed by the household")
	}
	return &att, nil
}

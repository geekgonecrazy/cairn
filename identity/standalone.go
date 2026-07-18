package identity

import (
	"crypto/ed25519"
	"fmt"
)

// SelfHousehold builds the identity-log objects for a STANDALONE participant that
// is its own household of one: the single key acts as household root, member root,
// and device key at once. Verifying a sender that signs with this key walks
// device(kp) → member(kp) → attestation(origin kp) and terminates at kp as the
// trusted root — so a carrier with no root adopts kp as its household when it
// stores the attestation.
//
// This is for headless clients — a CLI, a demo agent — that hold a single key and
// have no separate offline root. A human/browser uses the full tiered chain
// (household root → member → device → session) instead; do not use this there.
// operatedBy is the operating human's member root for kind "agent"; pass nil
// otherwise. Both returned objects are ready to publish via PutIdentityObject.
func SelfHousehold(kp KeyPair, kind Kind, operatedBy PubKey, displayName string, issuedAt int64) (*IdentityAttestation, *DeviceDelegation, error) {
	if len(kp.Pub) != ed25519.PublicKeySize {
		return nil, nil, fmt.Errorf("identity: standalone key must be a %d-byte pubkey", ed25519.PublicKeySize)
	}
	att := &IdentityAttestation{
		Pubkey:      append([]byte(nil), kp.Pub...),
		Kind:        kind,
		Origin:      append([]byte(nil), kp.Pub...), // its own household root
		OperatedBy:  append([]byte(nil), operatedBy...),
		DisplayName: displayName,
		IssuedAt:    issuedAt,
	}
	if err := Sign(att, kp.Priv); err != nil {
		return nil, nil, fmt.Errorf("identity: self-attestation: %w", err)
	}
	req, err := NewPairingRequest(kp.Pub, "self")
	if err != nil {
		return nil, nil, err
	}
	dd, err := ApprovePairing(req, kp.Pub, kp.Priv, issuedAt, 0)
	if err != nil {
		return nil, nil, err
	}
	return att, dd, nil
}

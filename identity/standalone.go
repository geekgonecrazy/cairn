package identity

import (
	"crypto/ed25519"
	"crypto/sha512"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

// hkdfInfoStandaloneDevice domain-separates a standalone participant's device
// key from the root it is derived under, so the two are independent keys even
// though one seed produces both.
const hkdfInfoStandaloneDevice = "cairn/standalone-device/v1"

// StandaloneDeviceKey derives the device key a standalone participant signs
// with, from the root key it holds.
//
// Derived rather than randomly generated so it is STABLE across runs: a headless
// client keeps one key file, and its device key — the thing room keys are
// wrapped to — is the same every time it starts. A fresh random device key each
// run would silently lose access to every room it had been admitted to.
func StandaloneDeviceKey(root KeyPair) (KeyPair, error) {
	if len(root.Priv) != ed25519.PrivateKeySize {
		return KeyPair{}, fmt.Errorf("identity: standalone root must carry a private key")
	}
	sk := make([]byte, ed25519.SeedSize)
	r := hkdf.New(sha512.New, root.Priv, nil, []byte(hkdfInfoStandaloneDevice))
	if _, err := io.ReadFull(r, sk); err != nil {
		return KeyPair{}, fmt.Errorf("identity: derive standalone device key: %w", err)
	}
	priv := ed25519.NewKeyFromSeed(sk)
	return KeyPair{Pub: priv.Public().(ed25519.PublicKey), Priv: priv}, nil
}

// SelfHousehold builds the identity-log objects for a STANDALONE participant
// that is its own household of one — a CLI, a demo agent, anything headless.
//
// The root key acts as household root AND member root; a DERIVED device key
// (StandaloneDeviceKey) is what actually signs events. That separation is not
// ceremony: devices form a delegation tree, and a key delegated to itself is a
// cycle the chain walk must refuse. It also matches the real model, where roots
// attest and devices sign, so a standalone client is a small instance of the
// same shape rather than a special case.
//
// Verifying a sender that signs with the returned device key walks
// device → member(root) → attestation(origin root) and terminates at the root —
// so a carrier with no root adopts it when it stores the attestation.
//
// A human/browser uses the full tiered chain (household root → member → device →
// session) instead; do not use this there. operatedBy is the operating human's
// member root for kind "agent"; pass nil otherwise.
//
// Returns the attestation and delegation to publish, plus the device keypair the
// caller MUST sign its events with — signing with the root key would not verify,
// because the root has no delegation of its own.
func SelfHousehold(
	root KeyPair,
	kind Kind,
	operatedBy PubKey,
	displayName string,
	issuedAt int64,
) (*IdentityAttestation, *DeviceDelegation, KeyPair, error) {
	if len(root.Pub) != ed25519.PublicKeySize {
		return nil, nil, KeyPair{}, fmt.Errorf(
			"identity: standalone key must be a %d-byte pubkey", ed25519.PublicKeySize)
	}
	att := &IdentityAttestation{
		Pubkey:      append([]byte(nil), root.Pub...),
		Kind:        kind,
		Origin:      append([]byte(nil), root.Pub...), // its own household root
		OperatedBy:  append([]byte(nil), operatedBy...),
		DisplayName: displayName,
		IssuedAt:    issuedAt,
	}
	if err := Sign(att, root.Priv); err != nil {
		return nil, nil, KeyPair{}, fmt.Errorf("identity: self-attestation: %w", err)
	}

	device, err := StandaloneDeviceKey(root)
	if err != nil {
		return nil, nil, KeyPair{}, err
	}
	req, err := NewPairingRequest(device.Pub, "self")
	if err != nil {
		return nil, nil, KeyPair{}, err
	}
	dd, err := ApprovePairing(req, root.Pub, root.Priv, issuedAt, 0)
	if err != nil {
		return nil, nil, KeyPair{}, err
	}
	return att, dd, device, nil
}

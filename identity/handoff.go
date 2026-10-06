package identity

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"strings"
)

// The handoff bundle: the show-once artifact a human hands an agent harness.
// `cairn:agent:1:` + base64url(det-CBOR). Everything the harness needs to
// bootstrap as the agent, and nothing else — the agent's root seed is the only
// secret in it. It is also the recovery: the same seed re-derives the root
// and (via StandaloneDeviceKey) the device.
//
// Field names are snake_case CBOR like every other identity object, and the
// bundle's byte layout is pinned by conformance vectors on both sides — a
// harness decodes this, so drift is a broken handoff, not a test failure.

const BundlePrefix = "cairn:agent:1:"

// HandoffBundle is the decoded bundle. Object fields carry the raw CBOR of
// the agent's identity-log objects so the harness can verify AND publish
// them itself.
type HandoffBundle struct {
	AgentSeed        []byte `cbor:"agent_seed"` // 32-byte root seed; THE secret
	RelayURL         string `cbor:"relay_url"`
	RelayPub         []byte `cbor:"relay_pub"`
	Invite           string `cbor:"invite"` // "" on an open relay
	Attestation      []byte `cbor:"attestation"`
	DeviceDelegation []byte `cbor:"device_delegation"`
	Vouch            []byte `cbor:"vouch"`
	AgentName        string `cbor:"agent_name"` // display convenience only
}

// EncodeHandoffBundle renders a bundle. The seed must be the agent root's
// 32-byte seed (an ed25519.PrivateKey's first 32 bytes, or noble's priv).
func EncodeHandoffBundle(b *HandoffBundle) (string, error) {
	if b == nil {
		return "", fmt.Errorf("identity: nil handoff bundle")
	}
	if len(b.AgentSeed) != ed25519.SeedSize {
		return "", fmt.Errorf("identity: agent seed must be %d bytes", ed25519.SeedSize)
	}
	if len(b.RelayPub) != ed25519.PublicKeySize {
		return "", fmt.Errorf("identity: relay pubkey must be %d bytes", ed25519.PublicKeySize)
	}
	body, err := detCBOR.Marshal(b)
	if err != nil {
		return "", fmt.Errorf("identity: encode handoff bundle: %w", err)
	}
	return BundlePrefix + base64.RawURLEncoding.EncodeToString(body), nil
}

// ParseHandoffBundle decodes AND validates a bundle: structure, cross-checks
// (seed → root → device → delegation; vouch operator == attested
// operated_by), and every signature. A harness MUST adopt through this, never
// by trusting the bytes — the bundle crossed a clipboard/QR gap and may be
// corrupt or hostile.
func ParseHandoffBundle(s string) (*HandoffBundle, error) {
	t := strings.TrimSpace(s)
	rest, ok := strings.CutPrefix(t, BundlePrefix)
	if !ok {
		return nil, fmt.Errorf("identity: not a Cairn agent bundle")
	}
	body, err := base64.RawURLEncoding.DecodeString(rest)
	if err != nil {
		return nil, fmt.Errorf("identity: malformed agent bundle: %w", err)
	}
	var b HandoffBundle
	if err := Unmarshal(body, &b); err != nil {
		return nil, fmt.Errorf("identity: undecodable agent bundle: %w", err)
	}
	if len(b.AgentSeed) != ed25519.SeedSize {
		return nil, fmt.Errorf("identity: bundle agent seed must be %d bytes", ed25519.SeedSize)
	}
	if len(b.RelayPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: bundle relay pubkey must be %d bytes", ed25519.PublicKeySize)
	}
	if b.RelayURL == "" {
		return nil, fmt.Errorf("identity: bundle is missing relay_url")
	}

	// Cross-checks: the objects must describe THIS seed, not just any agent.
	rootPriv := ed25519.NewKeyFromSeed(b.AgentSeed)
	rootPub := rootPriv.Public().(ed25519.PublicKey)
	device, err := StandaloneDeviceKey(KeyPair{Pub: rootPub, Priv: rootPriv})
	if err != nil {
		return nil, fmt.Errorf("identity: bundle device derivation: %w", err)
	}
	var att IdentityAttestation
	if err := Unmarshal(b.Attestation, &att); err != nil {
		return nil, fmt.Errorf("identity: bundle attestation undecodable: %w", err)
	}
	if !VerifyAttestation(&att) || !bytes.Equal(att.Pubkey, rootPub) {
		return nil, fmt.Errorf("identity: bundle attestation does not verify for this seed")
	}
	if att.Kind != KindAgent {
		return nil, fmt.Errorf("identity: bundle attestation is not kind=agent")
	}
	var dd DeviceDelegation
	if err := Unmarshal(b.DeviceDelegation, &dd); err != nil {
		return nil, fmt.Errorf("identity: bundle delegation undecodable: %w", err)
	}
	if !VerifyDeviceDelegation(&dd) || !bytes.Equal(dd.DevicePub, device.Pub) ||
		!bytes.Equal(dd.ParentPub, rootPub) {
		return nil, fmt.Errorf("identity: bundle delegation does not match this seed")
	}
	var vouch AgentDelegation
	if err := Unmarshal(b.Vouch, &vouch); err != nil {
		return nil, fmt.Errorf("identity: bundle vouch undecodable: %w", err)
	}
	if !VerifyAgentDelegation(&vouch) || !bytes.Equal(vouch.AgentPub, rootPub) {
		return nil, fmt.Errorf("identity: bundle vouch does not verify for this agent")
	}
	if !bytes.Equal(vouch.OperatorPub, att.OperatedBy) {
		return nil, fmt.Errorf("identity: bundle vouch names a different operator than the attestation")
	}
	return &b, nil
}

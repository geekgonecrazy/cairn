package identity

import (
	"encoding/hex"
	"testing"
)

// Golden identity vectors, asserted here AND in
// webapp/scripts/identity-conformance.ts against the same constants.
//
// These pin the household derivation, the attestation signing bytes, and the
// pairing wire format across the Go↔browser boundary. If a change to the CBOR
// encoding, the HKDF label, or a struct tag breaks parity, one of these two
// suites fails instead of the divergence surfacing as unverifiable events in
// production. Do not "fix" a failure by editing the constants — find the drift.

// BIP-39 256-bit all-zero-entropy test vector.
const conformanceMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon " +
	"abandon abandon abandon abandon abandon abandon abandon abandon " +
	"abandon abandon abandon abandon abandon abandon abandon art"

const (
	goldenRootPub     = "32320b447bf42226bac93895f0fae6e17b7e01c71114afb875bbcc3018d9f2fb"
	goldenRootPubPass = "3ad8f11fdced46794845eb00de0dc716012cf1cda63340445ca869a5d20fca7f"
	goldenAttSig      = "8f1e097a73031890084a894c01fe74bf6edf210ba9c5b5716419b6d0c409621a" +
		"49c4cba9e71c9cb49a4b8e5d8ac5af664990c0f0f4083d9757d9941b3f3ac707"
	goldenAttHash     = "3881da6f4d41eafce59092690a44dcf2af64bdabeb0f5bbd6785ffe80ea7955c"
	goldenPairEncoded = "cairn:pair:1:oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8:Sam's phone"
	goldenFingerprint = "a0a1-a2a3-a4a5-a6a7"
)

func TestConformance_HouseholdDerivation(t *testing.T) {
	kp, err := HouseholdRootFromMnemonic(conformanceMnemonic, "")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if got := hex.EncodeToString(kp.Pub); got != goldenRootPub {
		t.Errorf("root pub drifted from the browser:\n got %s\nwant %s", got, goldenRootPub)
	}

	withPass, err := HouseholdRootFromMnemonic(conformanceMnemonic, "trezor")
	if err != nil {
		t.Fatalf("derive with passphrase: %v", err)
	}
	if got := hex.EncodeToString(withPass.Pub); got != goldenRootPubPass {
		t.Errorf("passphrase root drifted:\n got %s\nwant %s", got, goldenRootPubPass)
	}
}

func TestConformance_AttestationSigningBytes(t *testing.T) {
	memberPub := make([]byte, 32)
	for i := range memberPub {
		memberPub[i] = byte(i)
	}
	att, err := ProvisionMember(
		conformanceMnemonic, "", memberPub, KindHuman, "Sam", nil, 1720000000000)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if got := hex.EncodeToString(att.Sig); got != goldenAttSig {
		t.Errorf("attestation signature drifted from the browser:\n got %s\nwant %s",
			got, goldenAttSig)
	}
	h, err := Hash(att)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if got := hex.EncodeToString(h[:]); got != goldenAttHash {
		t.Errorf("attestation content hash drifted:\n got %s\nwant %s", got, goldenAttHash)
	}
}

func TestConformance_PairingWireFormat(t *testing.T) {
	devicePub := make([]byte, 32)
	for i := range devicePub {
		devicePub[i] = byte(0xa0 + i)
	}
	req, err := NewPairingRequest(devicePub, "Sam's phone")
	if err != nil {
		t.Fatalf("pairing request: %v", err)
	}
	if got := req.Encode(); got != goldenPairEncoded {
		t.Errorf("pairing encoding drifted from the browser:\n got %s\nwant %s",
			got, goldenPairEncoded)
	}
	if got := Fingerprint(devicePub); got != goldenFingerprint {
		t.Errorf("fingerprint drifted:\n got %s\nwant %s", got, goldenFingerprint)
	}
}

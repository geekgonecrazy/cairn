package identity

import (
	"encoding/hex"
	"testing"
)

// Golden identity vectors, asserted here AND in
// webapp/scripts/identity-conformance.ts against the same constants.
//
// These pin the member-root derivation, the self-attestation signing bytes, the
// device delegation / revoke signing bytes, and the pairing wire format across
// the Go↔browser boundary. If a change to the CBOR encoding, the HKDF label, or a
// struct tag breaks parity, one of these two suites fails instead of the
// divergence surfacing as unverifiable events in production. Do not "fix" a
// failure by editing the constants — find the drift.

// BIP-39 256-bit all-zero-entropy test vector.
const conformanceMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon " +
	"abandon abandon abandon abandon abandon abandon abandon abandon " +
	"abandon abandon abandon abandon abandon abandon abandon art"

const (
	// The member root derived from the phrase — in the v2 model a member IS this
	// key; there is no household root above it.
	goldenMemberRootPub = "5c76722a889dec8d4736408eb6e741787750a30f61c98fef5d29a7226e061b51"

	// A member's SELF-signed attestation (kind=human, name "Sam", issued_at
	// 1720000000000), signed by the member key above. No `origin` field.
	goldenAttSig = "7697ffb5ef8b9d4c10c399cec91922ede6aa924959c9d2461221c017bd2e8ec1" +
		"16f73cfcc76013bc6d08e1c37cab303b831f140b903348324cf92985c347bc06"
	goldenAttHash = "4f433634bec07067d9673c629d9c812f401e6bf7ed797fcc16c0ccba0f1a1679"

	// A device delegation and a revoke for device 0xa0..0xbf, signed by the member
	// root as parent / revoker.
	goldenDelegationSig = "325186565b8ea2c171b13e2ac665325ca42729db6df2e6682241c255a95752b3" +
		"d031c1e3732631127a480d6f3c8fcb823628d729b97e651eb76fa466ff0c7109"
	goldenRevokeSig = "07e7ae3a05fe56c43d3562a5c6334a1755301125b30c7cda3aa8e5987a2c039d" +
		"ff1338748bc0dcfdbcf9334528959071b5f3fda9d093913a531ae434898ed206"

	goldenPairEncoded = "cairn:pair:1:oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8:Sam's phone"
	goldenFingerprint = "a0a1-a2a3-a4a5-a6a7"
)

func TestConformance_MemberRootDerivation(t *testing.T) {
	kp, err := MemberRootFromMnemonic(conformanceMnemonic, "")
	if err != nil {
		t.Fatalf("derive member root: %v", err)
	}
	if got := hex.EncodeToString(kp.Pub); got != goldenMemberRootPub {
		t.Errorf("member root drifted from the browser:\n got %s\nwant %s", got, goldenMemberRootPub)
	}
}

func TestConformance_SelfAttestationSigningBytes(t *testing.T) {
	member, err := MemberRootFromMnemonic(conformanceMnemonic, "")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	att, err := NewSelfAttestation(member, KindHuman, "Sam", nil, 1720000000000)
	if err != nil {
		t.Fatalf("self-attest: %v", err)
	}
	if got := hex.EncodeToString(att.Sig); got != goldenAttSig {
		t.Errorf("attestation signature drifted from the browser:\n got %s\nwant %s", got, goldenAttSig)
	}
	h, err := Hash(att)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if got := hex.EncodeToString(h[:]); got != goldenAttHash {
		t.Errorf("attestation content hash drifted:\n got %s\nwant %s", got, goldenAttHash)
	}
}

// The delegation and revoke signing bytes are what a device signs to admit or
// retire another device; Go↔browser drift here means one side admits a device the
// other rejects — the exact failure conformance exists to prevent.
func TestConformance_DelegationSigningBytes(t *testing.T) {
	parent, err := MemberRootFromMnemonic(conformanceMnemonic, "")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	devicePub := make([]byte, 32)
	for i := range devicePub {
		devicePub[i] = byte(0xa0 + i)
	}
	req, err := NewPairingRequest(devicePub, "Sam's phone")
	if err != nil {
		t.Fatalf("pairing request: %v", err)
	}
	dd, err := ApprovePairing(req, parent.Pub, parent.Priv, 1720000000000, 0)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if got := hex.EncodeToString(dd.Sig); got != goldenDelegationSig {
		t.Errorf("delegation signature drifted from the browser:\n got %s\nwant %s", got, goldenDelegationSig)
	}
}

func TestConformance_RevokeSigningBytes(t *testing.T) {
	revoker, err := MemberRootFromMnemonic(conformanceMnemonic, "")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	devicePub := make([]byte, 32)
	for i := range devicePub {
		devicePub[i] = byte(0xa0 + i)
	}
	dr, err := RevokeDevice(devicePub, revoker.Pub, revoker.Priv, 1720000000000)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if got := hex.EncodeToString(dr.Sig); got != goldenRevokeSig {
		t.Errorf("revoke signature drifted from the browser:\n got %s\nwant %s", got, goldenRevokeSig)
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
		t.Errorf("pairing encoding drifted from the browser:\n got %s\nwant %s", got, goldenPairEncoded)
	}
	if got := Fingerprint(devicePub); got != goldenFingerprint {
		t.Errorf("fingerprint drifted:\n got %s\nwant %s", got, goldenFingerprint)
	}
}

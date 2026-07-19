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

	// Same words, different key: the member-root label must never collide with
	// the household-root one, or a member could sign as their own household.
	goldenMemberRootPub = "5c76722a889dec8d4736408eb6e741787750a30f61c98fef5d29a7226e061b51"

	goldenJoinCode = "cairn:join:1:oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8:Sam"
	goldenInvite   = "cairn:att:1:qGNzaWdYQKYJdBsWOSU0K6MsvY_6Rn0DMuJNbN_id5hRjqcHSWJeDxFtQ3kOi_pS7P2O8QhLWHnq" +
		"QsSoB-i2mAd0ki3bDQdka2luZGVodW1hbmR0eXBldGlkZW50aXR5X2F0dGVzdGF0aW9uZm9yaWdpblggMjILRHv0Iia6yTiV8Prm" +
		"4Xt-AccRFK-4dbvMMBjZ8vtmcHVia2V5WCCgoaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2-v2lpc3N1ZWRfYXQbAAABkHf9" +
		"MABrb3BlcmF0ZWRfYnn2bGRpc3BsYXlfbmFtZWNTYW0"

	goldenDelegationSig = "31c61e17088c202fe7a594f2e418a7c5e1108cd746684d5a164e13afdecc3e46" +
		"ea8d26a2fa48f4bc0520c5baf158de3194393d4cca88c1b89f524ee1745c8408"
	goldenRevokeSig = "94fdd5259a246a127ff63e7944a6bb754296aca3bf1fcc2caa8b1622ca11c89d" +
		"c2e04d8f7b955442cbc29765681a69f409695d50802470bbe6bd9ead005f3606"
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

func TestConformance_MemberRootDerivation(t *testing.T) {
	kp, err := MemberRootFromMnemonic(conformanceMnemonic, "")
	if err != nil {
		t.Fatalf("derive member root: %v", err)
	}
	if got := hex.EncodeToString(kp.Pub); got != goldenMemberRootPub {
		t.Errorf("member root drifted from the browser:\n got %s\nwant %s", got, goldenMemberRootPub)
	}

	hh, err := HouseholdRootFromMnemonic(conformanceMnemonic, "")
	if err != nil {
		t.Fatalf("derive household root: %v", err)
	}
	if hex.EncodeToString(kp.Pub) == hex.EncodeToString(hh.Pub) {
		t.Fatal("member and household roots derive to the SAME key from the same words — " +
			"the HKDF domain separation is not working, and a member could sign attestations " +
			"as their own household")
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

// The delegation and revoke signing bytes were NOT pinned before the delegation
// tree landed, which is how `member_pub` → `parent_pub` / `revoker_pub` could be
// renamed with every suite still green. These are the objects a device signs to
// admit or retire another device, so Go↔browser drift here means one side admits
// a device the other rejects — the exact failure conformance exists to prevent.
func TestConformance_DelegationSigningBytes(t *testing.T) {
	parent, err := HouseholdRootFromMnemonic(conformanceMnemonic, "")
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
		t.Errorf("delegation signature drifted from the browser:\n got %s\nwant %s",
			got, goldenDelegationSig)
	}
}

func TestConformance_RevokeSigningBytes(t *testing.T) {
	revoker, err := HouseholdRootFromMnemonic(conformanceMnemonic, "")
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
		t.Errorf("revoke signature drifted from the browser:\n got %s\nwant %s",
			got, goldenRevokeSig)
	}
}

// Join codes and invite blobs cross the Go↔browser boundary in BOTH directions
// now that founding and attestation live in the CLI: the CLI parses a join code
// a browser produced, and a browser must verify an invite the CLI signed.
//
// The invite envelope is easy to get subtly wrong — a plain cbor.Marshal(map)
// sorts keys lexicographically where canonical CBOR sorts length-first, which
// still decodes and still VERIFIES (the signature covers the fields, not the
// envelope) while being byte-different. This pins the bytes.
func TestConformance_JoinAndInviteWireFormat(t *testing.T) {
	memberPub := make([]byte, 32)
	for i := range memberPub {
		memberPub[i] = byte(0xa0 + i)
	}
	jr, err := NewJoinRequest(memberPub, "Sam")
	if err != nil {
		t.Fatalf("join request: %v", err)
	}
	if got := jr.Encode(); got != goldenJoinCode {
		t.Errorf("join code drifted from the browser:\n got %s\nwant %s", got, goldenJoinCode)
	}

	att, err := ProvisionMember(
		conformanceMnemonic, "", memberPub, KindHuman, "Sam", nil, 1720000000000)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	blob, err := EncodeInvite(att)
	if err != nil {
		t.Fatalf("encode invite: %v", err)
	}
	if blob != goldenInvite {
		t.Errorf("invite blob drifted from the browser:\n got %s\nwant %s", blob, goldenInvite)
	}

	// And it round-trips back through the verifying parser.
	back, err := ParseInvite(blob)
	if err != nil {
		t.Fatalf("parse own invite: %v", err)
	}
	if back.DisplayName != "Sam" || string(back.Pubkey) != string(memberPub) {
		t.Fatalf("invite round-trip lost fields: %+v", back)
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

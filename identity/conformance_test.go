package identity

import (
	"crypto/ed25519"
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

	// An agent vouch and a withdrawal for agent 0xd0..0xef, signed by the
	// member root as delegator (= operator root: the durable, words-issued
	// vouch). Pins the agent_delegation / vouch_withdraw signing bytes.
	goldenVouchSig  = "9a47c3d95c8a9865bbae1737f745626cdf807e61758da9ef1223dbec122b6a07" +
		"0800749a79eaa05abfae4fed6a105a90bd17b2d3cde75854cc67219586688808"
	goldenVouchHash = "8a2f9e7ec96b0efb5f550ec83216782ba7581b780e847ee1f53bf35433926076"
	goldenWithdrawSig = "fd29aac8a81b84883fbf02eca651d9f8cb133440dabe368f78086c1575a3d12" +
		"07bc7a7853a8c74ee5041541eaf86aee1e19fb63bec8d3ad791f725ebd3eae60d"

	// The standalone device key for root seed 0x01..0x20 (the key a harness
	// signs with — the UI and the harness must derive the same one).
	goldenStandaloneDevicePub = "584aecc36777bd7b3b3e7558623a001b284f9235cbf0bbbcbcad79efb9a53fce"

	// The full handoff bundle for that agent (operator = the phrase root,
	// root-signed durable vouch, relay http://127.0.0.1:8099, no invite).
	// Pins the bundle layout a harness decodes.
	goldenHandoffBundle = "cairn:agent:1:qGV2b3VjaFj7pmNzaWdYQM1bI6eAdK_wdM9RiKVKPqYeXPgrTWdT0CiyhawDERFsG_Sbw0PodBLuyLs35nJ5UJTnTToyz7jK7W5zoCvY4gBkdHlwZXBhZ2VudF9kZWxlZ2F0aW9uaWFnZW50X3B1YlggebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmRpaXNzdWVkX2F0GwAAAZB3_TAAbG9wZXJhdG9yX3B1YlggXHZyKoid7I1HNkCOtudBeHdQow9hyY_vXSmnIm4GG1FtZGVsZWdhdG9yX3B1YlggXHZyKoid7I1HNkCOtudBeHdQow9hyY_vXSmnIm4GG1FmaW52aXRlYGlyZWxheV9wdWJYIODh4uPk5ebn6Onq6-zt7u_w8fLz9PX29_j5-vv8_f7_aXJlbGF5X3VybHVodHRwOi8vMTI3LjAuMC4xOjgwOTlqYWdlbnRfbmFtZWZIZWxwZXJqYWdlbnRfc2VlZFggAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyBrYXR0ZXN0YXRpb25Y6qdjc2lnWEDGqLuKoOG0mrHhHNpz7FDlxkMt05tflIFtqfmdAYkq0RFiWAZRVnxqT5RfayEzM7veTxNjUKFwvCDPr0cWVAYPZGtpbmRlYWdlbnRkdHlwZXRpZGVudGl0eV9hdHRlc3RhdGlvbmZwdWJrZXlYIHm1Vi6P5lT5QHixEuipi6eQH4U65pW-1-DjkQutBJZkaWlzc3VlZF9hdBsAAAGQd_0wAGtvcGVyYXRlZF9ieVggXHZyKoid7I1HNkCOtudBeHdQow9hyY_vXSmnIm4GG1FsZGlzcGxheV9uYW1lZkhlbHBlcnFkZXZpY2VfZGVsZWdhdGlvbljLpWNzaWdYQIkk6gNOgOaS8wFgl2rZonZdxv8hQY0xkZl8LtzUd1b78BI8aWCo0YtjzhWx-oln56pIQyAqOHXvIemVcSE6qwFkdHlwZXFkZXZpY2VfZGVsZWdhdGlvbmlpc3N1ZWRfYXQbAAABkHf9MABqZGV2aWNlX3B1YlggWErsw2d3vXs7PnVYYjoAGyhPkjXL8Lu8vK1577mlP85qcGFyZW50X3B1YlggebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ"
)

// handoffFixture builds the deterministic agent + bundle the handoff goldens
// pin. Shared by the device-key and bundle tests so the two cannot drift
// apart: the bundle test asserts the SAME device pub the device test pins.
func handoffFixture(t *testing.T) (seed []byte, root KeyPair, device KeyPair, bundle string) {
	t.Helper()
	seed = make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	rootPriv := ed25519.NewKeyFromSeed(seed)
	root = KeyPair{Pub: rootPriv.Public().(ed25519.PublicKey), Priv: rootPriv}

	var err error
	device, err = StandaloneDeviceKey(root)
	if err != nil {
		t.Fatalf("standalone device: %v", err)
	}

	operator, err := MemberRootFromMnemonic(conformanceMnemonic, "")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	att, err := NewSelfAttestation(root, KindAgent, "Helper", operator.Pub, 1720000000000)
	if err != nil {
		t.Fatalf("self-attest: %v", err)
	}
	req, err := NewPairingRequest(device.Pub, "Helper")
	if err != nil {
		t.Fatalf("pairing request: %v", err)
	}
	dd, err := ApprovePairing(req, root.Pub, root.Priv, 1720000000000, 0)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	vouch, err := IssueAgentVouch(root.Pub, operator.Pub, operator.Priv, operator.Pub, 1720000000000, 0)
	if err != nil {
		t.Fatalf("vouch: %v", err)
	}
	attB, err := Marshal(att)
	if err != nil {
		t.Fatal(err)
	}
	ddB, err := Marshal(dd)
	if err != nil {
		t.Fatal(err)
	}
	vouchB, err := Marshal(vouch)
	if err != nil {
		t.Fatal(err)
	}
	relayPub := make([]byte, 32)
	for i := range relayPub {
		relayPub[i] = byte(0xe0 + i)
	}
	bundle, err = EncodeHandoffBundle(&HandoffBundle{
		AgentSeed: seed, RelayURL: "http://127.0.0.1:8099", RelayPub: relayPub,
		Invite: "", Attestation: attB, DeviceDelegation: ddB, Vouch: vouchB,
		AgentName: "Helper",
	})
	if err != nil {
		t.Fatalf("encode bundle: %v", err)
	}
	return seed, root, device, bundle
}

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

func TestConformance_PairingWireFormat(t *testing.T) {	devicePub := make([]byte, 32)
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

// The vouch and withdrawal signing bytes are what an operator's device signs
// to prove (or un-prove) an agent. Drift here means one side accepts a vouch
// the other rejects — the exact failure conformance exists to prevent.
func TestConformance_VouchSigningBytes(t *testing.T) {
	root, err := MemberRootFromMnemonic(conformanceMnemonic, "")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	agentPub := make([]byte, 32)
	for i := range agentPub {
		agentPub[i] = byte(0xd0 + i)
	}
	d, err := IssueAgentVouch(agentPub, root.Pub, root.Priv, root.Pub, 1720000000000, 0)
	if err != nil {
		t.Fatalf("vouch: %v", err)
	}
	if got := hex.EncodeToString(d.Sig); got != goldenVouchSig {
		t.Errorf("vouch signature drifted from the browser:\n got %s\nwant %s", got, goldenVouchSig)
	}
	h, err := Hash(d)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if got := hex.EncodeToString(h[:]); got != goldenVouchHash {
		t.Errorf("vouch content hash drifted:\n got %s\nwant %s", got, goldenVouchHash)
	}
}

func TestConformance_WithdrawSigningBytes(t *testing.T) {	root, err := MemberRootFromMnemonic(conformanceMnemonic, "")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	agentPub := make([]byte, 32)
	for i := range agentPub {
		agentPub[i] = byte(0xd0 + i)
	}
	w, err := WithdrawVouch(agentPub, root.Pub, root.Priv, 1720000100000)
	if err != nil {
		t.Fatalf("withdraw: %v", err)
	}
	if got := hex.EncodeToString(w.Sig); got != goldenWithdrawSig {
		t.Errorf("withdraw signature drifted from the browser:\n got %s\nwant %s", got, goldenWithdrawSig)
	}
}

// The harness and the UI must derive the SAME device key from the agent seed —
// otherwise room keys wrap to a device the harness cannot open. Deterministic
// from the fixed seed, so both sides pin it.
func TestConformance_StandaloneDeviceKey(t *testing.T) {
	_, _, device, _ := handoffFixture(t)
	if got := hex.EncodeToString(device.Pub); got != goldenStandaloneDevicePub {
		t.Errorf("standalone device drifted from the browser:\n got %s\nwant %s", got, goldenStandaloneDevicePub)
	}
}

// The bundle layout a harness decodes. Round-trips through Parse (which
// cross-checks seed → root → device → delegation and vouch operator), so this
// pins both the encoding and the validation both sides implement.
func TestConformance_HandoffBundle(t *testing.T) {
	_, _, _, bundle := handoffFixture(t)
	if bundle != goldenHandoffBundle {
		t.Errorf("handoff bundle drifted from the browser:\n got %s\nwant %s", bundle, goldenHandoffBundle)
	}
	if _, err := ParseHandoffBundle(bundle); err != nil {
		t.Errorf("golden bundle does not parse: %v", err)
	}
}

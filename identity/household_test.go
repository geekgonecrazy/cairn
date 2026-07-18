package identity

import (
	"crypto/ed25519"
	"strings"
	"testing"
)

const testNow = int64(1_700_000_000_000)

func TestMnemonicRoundTripIsDeterministic(t *testing.T) {
	hh, err := Bootstrap()
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if n := len(strings.Fields(hh.Mnemonic)); n != MnemonicWords {
		t.Fatalf("mnemonic = %d words, want %d", n, MnemonicWords)
	}

	// The whole recovery story rests on this: same words → same household id.
	again, err := HouseholdRootFromMnemonic(hh.Mnemonic, "")
	if err != nil {
		t.Fatalf("re-derive: %v", err)
	}
	if !again.Pub.Equal(hh.RootPub) {
		t.Fatal("re-deriving from the same mnemonic produced a different household root")
	}
}

func TestMnemonicNormalization(t *testing.T) {
	hh, err := Bootstrap()
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	// How a phrase looks after being copied off paper by a human.
	messy := "  " + strings.ToUpper(hh.Mnemonic) + "  "
	messy = strings.ReplaceAll(messy, " ", "  ")

	kp, err := HouseholdRootFromMnemonic(messy, "")
	if err != nil {
		t.Fatalf("messy mnemonic rejected: %v", err)
	}
	if !kp.Pub.Equal(hh.RootPub) {
		t.Fatal("case/whitespace changed the derived household root")
	}
}

func TestMnemonicPassphraseYieldsDifferentHousehold(t *testing.T) {
	hh, _ := Bootstrap()
	a, err := HouseholdRootFromMnemonic(hh.Mnemonic, "")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	b, err := HouseholdRootFromMnemonic(hh.Mnemonic, "passphrase")
	if err != nil {
		t.Fatalf("derive with passphrase: %v", err)
	}
	if a.Pub.Equal(b.Pub) {
		t.Fatal("passphrase did not change the derived household")
	}
}

func TestValidateMnemonicRejectsBadInput(t *testing.T) {
	hh, _ := Bootstrap()
	words := strings.Fields(hh.Mnemonic)

	cases := map[string]string{
		"empty":       "",
		"short":       strings.Join(words[:12], " "),
		"long":        hh.Mnemonic + " abandon",
		"typo":        strings.Join(append([]string{"zzzz"}, words[1:]...), " "),
		"not in list": strings.Join(append([]string{"aaron"}, words[1:]...), " "),
	}
	for name, m := range cases {
		t.Run(name, func(t *testing.T) {
			if err := ValidateMnemonic(m); err == nil {
				t.Fatalf("ValidateMnemonic(%q) = nil, want error", name)
			}
			if _, err := HouseholdRootFromMnemonic(m, ""); err == nil {
				t.Fatal("derivation accepted an invalid mnemonic")
			}
		})
	}
}

// A single swapped word must not silently derive a valid-but-wrong household.
func TestMnemonicChecksumCatchesSwappedWord(t *testing.T) {
	hh, _ := Bootstrap()
	words := strings.Fields(hh.Mnemonic)
	words[0], words[1] = words[1], words[0]
	swapped := strings.Join(words, " ")
	if swapped == hh.Mnemonic {
		t.Skip("first two words identical")
	}
	if err := ValidateMnemonic(swapped); err == nil {
		// BIP-39 checksums catch this with ~1/16 escape probability per the
		// spec; if it ever passes, the derived household must still differ.
		kp, derr := HouseholdRootFromMnemonic(swapped, "")
		if derr == nil && kp.Pub.Equal(hh.RootPub) {
			t.Fatal("swapped words derived the SAME household root")
		}
	}
}

func TestProvisionMemberProducesVerifiableChain(t *testing.T) {
	hh, _ := Bootstrap()
	member, _ := GenerateKey()
	device, _ := GenerateKey()

	att, err := ProvisionMember(hh.Mnemonic, "", member.Pub, KindHuman, "Sam", nil, testNow)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	dd, err := ApprovePairing(
		mustPairing(t, device.Pub, "Sam's phone"), member.Pub, member.Priv, testNow, 0)
	if err != nil {
		t.Fatalf("approve pairing: %v", err)
	}

	log := NewDeviceLog()
	if err := log.AddAttestation(att); err != nil {
		t.Fatalf("add attestation: %v", err)
	}
	if err := log.AddDelegation(dd); err != nil {
		t.Fatalf("add delegation: %v", err)
	}

	got, err := VerifySender(device.Pub, log, [][]byte{hh.RootPub}, testNow)
	if err != nil {
		t.Fatalf("VerifySender: %v", err)
	}
	if got.DisplayName != "Sam" || got.Kind != KindHuman {
		t.Fatalf("resolved = %+v, want Sam/human", got)
	}
	if !ed25519.PublicKey(got.Origin).Equal(hh.RootPub) {
		t.Fatal("resolved origin is not the household root")
	}
}

func TestProvisionMemberRejectsBadKindOperatedBy(t *testing.T) {
	hh, _ := Bootstrap()
	member, _ := GenerateKey()
	human, _ := GenerateKey()

	if _, err := ProvisionMember(
		hh.Mnemonic, "", member.Pub, KindAgent, "atlas", nil, testNow); err == nil {
		t.Fatal("agent without operated_by was accepted")
	}
	if _, err := ProvisionMember(
		hh.Mnemonic, "", member.Pub, KindHuman, "Sam", human.Pub, testNow); err == nil {
		t.Fatal("human with operated_by was accepted")
	}
	if _, err := ProvisionMember(
		hh.Mnemonic, "", member.Pub, Kind("wizard"), "x", nil, testNow); err == nil {
		t.Fatal("unknown kind was accepted")
	}
}

// Recovery: the words alone must re-mint a working identity on a new device.
func TestRecoveryFromWordsOnly(t *testing.T) {
	hh, _ := Bootstrap()
	words := hh.Mnemonic // all that survives; every device is gone

	newMember, _ := GenerateKey()
	newDevice, _ := GenerateKey()

	att, err := ProvisionMember(words, "", newMember.Pub, KindHuman, "Sam", nil, testNow)
	if err != nil {
		t.Fatalf("re-provision: %v", err)
	}
	dd, _ := ApprovePairing(
		mustPairing(t, newDevice.Pub, "replacement"), newMember.Pub, newMember.Priv, testNow, 0)

	log := NewDeviceLog()
	_ = log.AddAttestation(att)
	_ = log.AddDelegation(dd)

	// The household id is unchanged, so peers' existing trustedRoots still work.
	if _, err := VerifySender(newDevice.Pub, log, [][]byte{hh.RootPub}, testNow); err != nil {
		t.Fatalf("recovered identity does not verify against the original root: %v", err)
	}
}

func mustPairing(t *testing.T, pub PubKey, label string) *PairingRequest {
	t.Helper()
	req, err := NewPairingRequest(pub, label)
	if err != nil {
		t.Fatalf("pairing request: %v", err)
	}
	return req
}

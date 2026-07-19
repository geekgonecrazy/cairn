package identity

// Household-root bootstrap and recovery — the apex of the delegation chain.
//
// SHAPE (resolves the PROTOCOL.md §298 / plan.md §5 open question):
//
// The household root is an OFFLINE-ONLY apex. It signs exactly one kind of
// object — IdentityAttestation, binding a member root to this household — and
// nothing else. It is derived deterministically from a 24-word BIP-39 mnemonic
// and is never persisted: Bootstrap and ProvisionMember reconstruct it from the
// mnemonic, use it, and drop it. No device stores the root private key, so
// there is nothing on a device whose theft compromises the household.
//
// Recovery is therefore "re-derive the root from the words, then re-attest a
// fresh member root" — not "restore a backup". Losing every device loses the
// per-room message keys (pre-join history stays opaque, per PROTOCOL.md §3),
// but the household identity itself survives in the words.
//
// The mnemonic is BIP-39 with 256 bits of entropy (24 words). The BIP-39 seed
// is domain-separated through HKDF-SHA-512 before it becomes an Ed25519 seed,
// so the same words can later derive additional independent keys (a member-root
// recovery key, say) without either derivation being able to forge the other.

import (
	"crypto/ed25519"
	"crypto/sha512"
	"fmt"
	"io"

	bip39 "github.com/tyler-smith/go-bip39"
	"golang.org/x/crypto/hkdf"
)

// MnemonicWords is the required mnemonic length. 24 words = 256 bits of
// entropy, matching the Ed25519 seed size; shorter mnemonics are rejected
// rather than stretched.
const MnemonicWords = 24

// hkdfInfoHouseholdRoot domain-separates the household-root derivation from any
// future key derived from the same mnemonic. Never reuse this label.
const hkdfInfoHouseholdRoot = "cairn/household-root/v1"

// hkdfInfoMemberRoot domain-separates a MEMBER root from a household root. Both
// are derived from 24 words, and a member who founded the household holds two
// separate phrases; the labels guarantee neither derivation can produce the
// other's key even if the same words were somehow reused.
const hkdfInfoMemberRoot = "cairn/member-root/v1"

// NewMnemonic generates a fresh 24-word BIP-39 mnemonic. This is the only
// artifact that must leave the device to be written down; it is shown once,
// during bootstrap, and never recoverable from Cairn afterwards.
func NewMnemonic() (string, error) {
	entropy, err := bip39.NewEntropy(256)
	if err != nil {
		return "", fmt.Errorf("identity: mnemonic entropy: %w", err)
	}
	m, err := bip39.NewMnemonic(entropy)
	if err != nil {
		return "", fmt.Errorf("identity: new mnemonic: %w", err)
	}
	return m, nil
}

// ValidateMnemonic reports whether s is a well-formed 24-word BIP-39 mnemonic
// with a valid checksum. Used to gate the recovery flow before deriving, so a
// typo surfaces as "that isn't your phrase" rather than as a silently different
// household whose events nobody will accept.
func ValidateMnemonic(s string) error {
	if n := len(splitWords(s)); n != MnemonicWords {
		return fmt.Errorf("identity: mnemonic must be %d words, got %d", MnemonicWords, n)
	}
	if !bip39.IsMnemonicValid(normalizeMnemonic(s)) {
		return fmt.Errorf("identity: mnemonic checksum invalid (check for typos)")
	}
	return nil
}

// HouseholdRootFromMnemonic deterministically derives the household root
// keypair from a mnemonic. The same words always yield the same household id
// (the root pubkey), which is what makes recovery possible.
//
// passphrase is the BIP-39 optional passphrase ("25th word"); pass "" if the
// household does not use one. Note that a different passphrase yields a
// DIFFERENT household, not an error — that is BIP-39's plausible-deniability
// property, and it means a mistyped passphrase looks like a stranger's
// household rather than a failure.
func HouseholdRootFromMnemonic(mnemonic, passphrase string) (KeyPair, error) {
	if err := ValidateMnemonic(mnemonic); err != nil {
		return KeyPair{}, err
	}
	seed := bip39.NewSeed(normalizeMnemonic(mnemonic), passphrase)

	// Domain-separate before touching Ed25519, so this derivation can never
	// collide with another key derived from the same words.
	sk := make([]byte, ed25519.SeedSize)
	r := hkdf.New(sha512.New, seed, nil, []byte(hkdfInfoHouseholdRoot))
	if _, err := io.ReadFull(r, sk); err != nil {
		return KeyPair{}, fmt.Errorf("identity: derive household root: %w", err)
	}
	priv := ed25519.NewKeyFromSeed(sk)
	return KeyPair{Pub: priv.Public().(ed25519.PublicKey), Priv: priv}, nil
}

// MemberRootFromMnemonic deterministically derives a MEMBER root keypair from
// that member's own mnemonic — a different set of words from the household's.
//
// A member root is an offline apex, exactly like the household root: it signs
// the member's FIRST device delegation and is then put away, never persisted on
// any device. Every device after that is paired from an existing device, which
// signs as parent (see DeviceDelegation). That is what makes device revocation
// meaningful — a stolen device holds no key that can admit a replacement — and
// it is why room keys wrap to DEVICE keys rather than to this one.
//
// Domain-separated from the household derivation, so the same words could never
// produce both and one can never be used to forge the other. Everything the
// household note above says about a wrong passphrase applies here too: it yields
// a different member root, not an error.
func MemberRootFromMnemonic(mnemonic, passphrase string) (KeyPair, error) {
	if err := ValidateMnemonic(mnemonic); err != nil {
		return KeyPair{}, err
	}
	seed := bip39.NewSeed(normalizeMnemonic(mnemonic), passphrase)

	sk := make([]byte, ed25519.SeedSize)
	r := hkdf.New(sha512.New, seed, nil, []byte(hkdfInfoMemberRoot))
	if _, err := io.ReadFull(r, sk); err != nil {
		return KeyPair{}, fmt.Errorf("identity: derive member root: %w", err)
	}
	priv := ed25519.NewKeyFromSeed(sk)
	return KeyPair{Pub: priv.Public().(ed25519.PublicKey), Priv: priv}, nil
}

// Household is a bootstrapped household: its root public key (the household id,
// and the value that belongs in trustedRoots) plus the mnemonic that regenerates
// the root. The private key is deliberately absent — callers re-derive it from
// the mnemonic for the rare operations that need it.
type Household struct {
	RootPub  PubKey
	Mnemonic string
}

// Bootstrap creates a new household: fresh mnemonic, derived root, nothing
// persisted. The caller must show Mnemonic to the human and confirm it was
// recorded before relying on the household — there is no second chance to
// display it.
func Bootstrap() (*Household, error) {
	m, err := NewMnemonic()
	if err != nil {
		return nil, err
	}
	kp, err := HouseholdRootFromMnemonic(m, "")
	if err != nil {
		return nil, err
	}
	return &Household{RootPub: kp.Pub, Mnemonic: m}, nil
}

// ProvisionMember mints the IdentityAttestation binding memberPub to this
// household, signed by the root re-derived from mnemonic. This is the single
// operation the offline apex exists to perform.
//
// kind and displayName are immutable once attested (PROTOCOL.md §1), so callers
// must not treat this as an editable profile. operatedBy names the operating
// human member root for KindAgent and must be nil otherwise.
func ProvisionMember(
	mnemonic, passphrase string,
	memberPub PubKey,
	kind Kind,
	displayName string,
	operatedBy PubKey,
	issuedAt int64,
) (*IdentityAttestation, error) {
	if len(memberPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: member pubkey must be %d bytes, got %d",
			ed25519.PublicKeySize, len(memberPub))
	}
	switch kind {
	case KindHuman, KindService:
		if len(operatedBy) != 0 {
			return nil, fmt.Errorf("identity: operated_by is only valid for kind %q", KindAgent)
		}
	case KindAgent:
		if len(operatedBy) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("identity: kind %q requires an operated_by member root", KindAgent)
		}
	default:
		return nil, fmt.Errorf("identity: unknown kind %q", kind)
	}

	root, err := HouseholdRootFromMnemonic(mnemonic, passphrase)
	if err != nil {
		return nil, err
	}

	att := &IdentityAttestation{
		Pubkey:      append([]byte(nil), memberPub...),
		Kind:        kind,
		Origin:      append([]byte(nil), root.Pub...),
		OperatedBy:  append([]byte(nil), operatedBy...),
		DisplayName: displayName,
		IssuedAt:    issuedAt,
	}
	if err := Sign(att, root.Priv); err != nil {
		return nil, fmt.Errorf("identity: sign attestation: %w", err)
	}
	return att, nil
}

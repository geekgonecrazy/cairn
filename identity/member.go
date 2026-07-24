package identity

// Member identity — the top of the chain in the v2 trust model.
//
// A member is simply an Ed25519 keypair. There is no household root above it:
// a member root is the top of its own device-delegation tree and the anchor a
// verifier resolves a sender to (see VerifySender). Whether you *trust* that
// member key is an edge decision — you verified it (pairing / fingerprint) or a
// room you're in admitted it — not a chain to some apex. See
// docs/adrs/0013-pubkey-identity-no-household.md.
//
// The key may be derived deterministically from a 24-word BIP-39 recovery phrase
// so it can be restored on a fresh device. The phrase is the ONLY thing that must
// leave the device to be written down; it is shown once and never recoverable
// from Cairn afterwards.

import (
	"crypto/ed25519"
	"crypto/sha512"
	"fmt"
	"io"

	bip39 "github.com/tyler-smith/go-bip39"
	"golang.org/x/crypto/hkdf"
)

// MnemonicWords is the required recovery-phrase length. 24 words = 256 bits of
// entropy, matching the Ed25519 seed size; shorter phrases are rejected rather
// than stretched.
const MnemonicWords = 24

// hkdfInfoMemberRoot domain-separates a member root derived from a recovery
// phrase, so the same words could later derive other independent keys without
// either derivation being able to forge the other. Never reuse this label.
const hkdfInfoMemberRoot = "cairn/member-root/v1"

// NewMnemonic generates a fresh 24-word BIP-39 recovery phrase. It is shown once,
// during onboarding, and is not recoverable from Cairn afterwards.
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

// ValidateMnemonic reports whether s is a well-formed 24-word BIP-39 phrase with
// a valid checksum. Used to gate recovery before deriving, so a typo surfaces as
// "that isn't your phrase" rather than as a silently different identity.
func ValidateMnemonic(s string) error {
	if n := len(splitWords(s)); n != MnemonicWords {
		return fmt.Errorf("identity: mnemonic must be %d words, got %d", MnemonicWords, n)
	}
	if !bip39.IsMnemonicValid(normalizeMnemonic(s)) {
		return fmt.Errorf("identity: mnemonic checksum invalid (check for typos)")
	}
	return nil
}

// MemberRootFromMnemonic deterministically derives a member keypair from a
// recovery phrase. The same words always yield the same member key (the identity
// itself), which is what makes recovery possible.
//
// passphrase is the BIP-39 optional passphrase ("25th word"); pass "" if unused.
// A different passphrase yields a DIFFERENT key, not an error — BIP-39's
// plausible-deniability property — so the UI must make "nobody recognizes you"
// legible rather than looking like a bug.
func MemberRootFromMnemonic(mnemonic, passphrase string) (KeyPair, error) {
	if err := ValidateMnemonic(mnemonic); err != nil {
		return KeyPair{}, err
	}
	seed := bip39.NewSeed(normalizeMnemonic(mnemonic), passphrase)

	// Domain-separate before touching Ed25519, so this derivation can never
	// collide with another key derived from the same words.
	sk := make([]byte, ed25519.SeedSize)
	r := hkdf.New(sha512.New, seed, nil, []byte(hkdfInfoMemberRoot))
	if _, err := io.ReadFull(r, sk); err != nil {
		return KeyPair{}, fmt.Errorf("identity: derive member root: %w", err)
	}
	priv := ed25519.NewKeyFromSeed(sk)
	return KeyPair{Pub: priv.Public().(ed25519.PublicKey), Priv: priv}, nil
}

// NewSelfAttestation builds the IdentityAttestation a member signs for ITSELF —
// its self-asserted profile: kind, display name, and (for an agent) the operating
// human. There is no household to countersign it; the signer is the member key,
// and the name/kind are labels a peer decides how much to trust (docs:
// verification tiers). kind is immutable once published.
//
// operatedBy names the operating human's member root for KindAgent and must be
// nil otherwise.
func NewSelfAttestation(
	member KeyPair,
	kind Kind,
	displayName string,
	operatedBy PubKey,
	issuedAt int64,
) (*IdentityAttestation, error) {
	if len(member.Pub) != ed25519.PublicKeySize || len(member.Priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("identity: self-attestation needs a full member keypair")
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

	att := &IdentityAttestation{
		Pubkey:      append([]byte(nil), member.Pub...),
		Kind:        kind,
		OperatedBy:  append([]byte(nil), operatedBy...),
		DisplayName: displayName,
		IssuedAt:    issuedAt,
	}
	if err := Sign(att, member.Priv); err != nil {
		return nil, fmt.Errorf("identity: sign self-attestation: %w", err)
	}
	return att, nil
}

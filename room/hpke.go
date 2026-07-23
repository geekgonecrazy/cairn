package room

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha512"
	"encoding/binary"
	"fmt"

	"filippo.io/edwards25519"
	"github.com/cloudflare/circl/hpke"
)

// Room keys are handed to members by wrapping them with HPKE to each member's
// public key (docs/protocol.md §5). We reuse the member's Ed25519 identity key as the
// HPKE recipient key by converting it to X25519 (the standard birational map,
// same as libsodium crypto_sign_ed25519_*_to_curve25519) — so no separate KEM
// key needs to be published or attested.
//
// Suite: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM (RFC 9180 base).

var (
	hpkeKEM  = hpke.KEM_X25519_HKDF_SHA256
	hpkeKDF  = hpke.KDF_HKDF_SHA256
	hpkeAEAD = hpke.AEAD_AES256GCM
)

// hpkeInfo is the HPKE "info" context string; both wrap and unwrap must agree.
var hpkeInfo = []byte("cairn/room-key/v1")

// EdToX25519Public converts an Ed25519 public key to its X25519 (Montgomery)
// public key.
func EdToX25519Public(edPub []byte) ([]byte, error) {
	if len(edPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("room: bad ed25519 public key length %d", len(edPub))
	}
	p, err := new(edwards25519.Point).SetBytes(edPub)
	if err != nil {
		return nil, fmt.Errorf("room: ed25519 pub decode: %w", err)
	}
	return p.BytesMontgomery(), nil
}

// EdToX25519Private converts an Ed25519 private key to its X25519 scalar:
// clamp(SHA-512(seed)[:32]).
func EdToX25519Private(edPriv ed25519.PrivateKey) []byte {
	seed := edPriv.Seed()
	h := sha512.Sum512(seed)
	x := h[:32]
	x[0] &= 248
	x[31] &= 127
	x[31] |= 64
	return x
}

// WrapKey HPKE-seals roomKey to recipientEdPub. The returned blob is
// uvarint(len(enc)) || enc || ciphertext — self-describing so UnwrapKey can split
// it without knowing the KEM's encapsulation size a priori.
func WrapKey(recipientEdPub, roomKey []byte) ([]byte, error) {
	xPub, err := EdToX25519Public(recipientEdPub)
	if err != nil {
		return nil, err
	}
	pub, err := hpkeKEM.Scheme().UnmarshalBinaryPublicKey(xPub)
	if err != nil {
		return nil, fmt.Errorf("room: hpke pub: %w", err)
	}
	sender, err := hpke.NewSuite(hpkeKEM, hpkeKDF, hpkeAEAD).NewSender(pub, hpkeInfo)
	if err != nil {
		return nil, fmt.Errorf("room: hpke sender: %w", err)
	}
	enc, sealer, err := sender.Setup(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("room: hpke setup: %w", err)
	}
	ct, err := sealer.Seal(roomKey, nil)
	if err != nil {
		return nil, fmt.Errorf("room: hpke seal: %w", err)
	}
	var lb [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(lb[:], uint64(len(enc)))
	out := make([]byte, 0, n+len(enc)+len(ct))
	out = append(out, lb[:n]...)
	out = append(out, enc...)
	out = append(out, ct...)
	return out, nil
}

// UnwrapKey HPKE-opens a blob produced by WrapKey using recipientEdPriv.
func UnwrapKey(recipientEdPriv ed25519.PrivateKey, blob []byte) ([]byte, error) {
	encLen, n := binary.Uvarint(blob)
	if n <= 0 || int(encLen)+n > len(blob) {
		return nil, fmt.Errorf("room: bad wrapped-key framing")
	}
	enc := blob[n : n+int(encLen)]
	ct := blob[n+int(encLen):]

	xPriv := EdToX25519Private(recipientEdPriv)
	priv, err := hpkeKEM.Scheme().UnmarshalBinaryPrivateKey(xPriv)
	if err != nil {
		return nil, fmt.Errorf("room: hpke priv: %w", err)
	}
	recv, err := hpke.NewSuite(hpkeKEM, hpkeKDF, hpkeAEAD).NewReceiver(priv, hpkeInfo)
	if err != nil {
		return nil, fmt.Errorf("room: hpke receiver: %w", err)
	}
	opener, err := recv.Setup(enc)
	if err != nil {
		return nil, fmt.Errorf("room: hpke setup: %w", err)
	}
	roomKey, err := opener.Open(ct, nil)
	if err != nil {
		return nil, fmt.Errorf("room: hpke open: %w", err)
	}
	return roomKey, nil
}

// Package identity implements Cairn's three-tier Ed25519 delegation chain:
//
//	household root  → member root / service  → device / instance key  → session key
//
// No key is ever copied. Each identity generates its own keypair and holds only
// its own private key; trust propagates as signed, content-addressed attestation
// objects that live in the household identity log (not in any room). A verifier
// walks a sender's key back to a household root it recognizes — see Chain.
//
// Objects are canonicalized with deterministic CBOR (RFC 8949 §4.2) and addressed
// by their BLAKE3-256 hash. See PROTOCOL.md §1.
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"

	"github.com/fxamacker/cbor/v2"
	"lukechampine.com/blake3"
)

// Kind is the attested role of a member-root identity. It is IMMUTABLE once
// attested and comes from the attestation, never self-asserted.
type Kind string

const (
	KindHuman   Kind = "human"   // a person; a room member
	KindAgent   Kind = "agent"   // an autonomous agent; a room member
	KindService Kind = "service" // plumbing (broker, gateway); NOT a room member
)

// PubKey / PrivKey are raw Ed25519 keys. PubKey is 32 bytes and is used
// directly as an identity's address throughout the protocol.
type PubKey = ed25519.PublicKey

// KeyPair is a freshly generated Ed25519 identity keypair.
type KeyPair struct {
	Pub  ed25519.PublicKey
	Priv ed25519.PrivateKey
}

// GenerateKey creates a new Ed25519 keypair for any tier of the chain.
func GenerateKey() (KeyPair, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return KeyPair{}, fmt.Errorf("identity: generate key: %w", err)
	}
	return KeyPair{Pub: pub, Priv: priv}, nil
}

// detCBOR is the canonical encoder for all identity-log objects and event
// content: RFC 8949 §4.2 core deterministic (sorted keys, shortest-form ints).
var detCBOR = func() cbor.EncMode {
	em, err := cbor.CoreDetEncOptions().EncMode()
	if err != nil {
		panic("identity: cbor det enc mode: " + err.Error())
	}
	return em
}()

// Marshal encodes v as deterministic CBOR (exported for reuse by event/room).
func Marshal(v any) ([]byte, error) { return detCBOR.Marshal(v) }

// Unmarshal decodes CBOR into v (the counterpart to Marshal).
func Unmarshal(b []byte, v any) error { return cbor.Unmarshal(b, v) }

// Hash returns the BLAKE3-256 content address of the deterministic-CBOR
// encoding of v. This is how identity-log objects are named and fetched.
func Hash(v any) ([32]byte, error) {
	b, err := detCBOR.Marshal(v)
	if err != nil {
		return [32]byte{}, err
	}
	return blake3.Sum256(b), nil
}

// ---------------------------------------------------------------------------
// Identity-log objects (CBOR, content-addressed, fetched by hash).
//
// Every object's `Sig` is Ed25519 over the deterministic-CBOR of the object
// with Sig cleared — see signingBytes. Struct field CBOR keys are the string
// names from PROTOCOL.md §1; deterministic encoding sorts them canonically.
// ---------------------------------------------------------------------------

// IdentityAttestation binds a member-root pubkey to a household root (origin).
// Signed by the household root. kind and origin are IMMUTABLE.
type IdentityAttestation struct {
	Pubkey      []byte `cbor:"pubkey"`
	Kind        Kind   `cbor:"kind"`
	Origin      []byte `cbor:"origin"`      // household root pubkey; also the household id
	OperatedBy  []byte `cbor:"operated_by"` // for agents: the human member root, else nil
	DisplayName string `cbor:"display_name"`
	IssuedAt    int64  `cbor:"issued_at"` // unix ms
	Sig         []byte `cbor:"sig"`
}

// DeviceDelegation authorizes a device/instance key under a member root.
// Signed by the member root.
type DeviceDelegation struct {
	DevicePub []byte `cbor:"device_pub"`
	MemberPub []byte `cbor:"member_pub"`
	IssuedAt  int64  `cbor:"issued_at"`            // unix ms
	ExpiresAt int64  `cbor:"expires_at,omitempty"` // unix ms; 0 = no expiry
	Sig       []byte `cbor:"sig"`
}

// SessionDelegation authorizes a short-lived session key under a device key.
// Browser only; signed by the device key (a WebAuthn passkey). Verifiers accept
// the WebAuthn signature envelope for the Sig — see PROTOCOL.md §2.3.
type SessionDelegation struct {
	SessionPub []byte `cbor:"session_pub"`
	DevicePub  []byte `cbor:"device_pub"`
	Scope      string `cbor:"scope"`
	ExpiresAt  int64  `cbor:"expires_at"` // unix ms
	Sig        []byte `cbor:"sig"`
}

// DeviceRevoke revokes a device delegation. Signed by the member root.
type DeviceRevoke struct {
	DevicePub []byte `cbor:"device_pub"`
	MemberPub []byte `cbor:"member_pub"`
	RevokedAt int64  `cbor:"revoked_at"` // unix ms
	Sig       []byte `cbor:"sig"`
}

// signable is any identity-log object that carries a detached Ed25519 signature
// over its own deterministic-CBOR content (with the signature field cleared).
type signable interface {
	*IdentityAttestation | *DeviceDelegation | *SessionDelegation | *DeviceRevoke
}

// signingBytes returns the deterministic-CBOR of obj with its Sig field cleared,
// which is exactly what the issuer signs and a verifier checks.
func signingBytes[T signable](obj T) ([]byte, error) {
	switch o := any(obj).(type) {
	case *IdentityAttestation:
		c := *o
		c.Sig = nil
		return detCBOR.Marshal(&c)
	case *DeviceDelegation:
		c := *o
		c.Sig = nil
		return detCBOR.Marshal(&c)
	case *SessionDelegation:
		c := *o
		c.Sig = nil
		return detCBOR.Marshal(&c)
	case *DeviceRevoke:
		c := *o
		c.Sig = nil
		return detCBOR.Marshal(&c)
	default:
		return nil, fmt.Errorf("identity: unsignable type %T", obj)
	}
}

// Sign fills obj.Sig with an Ed25519 signature by priv over the object's
// signing bytes. The caller is responsible for using the correct issuer key
// (household root for attestations, member root for delegations/revokes, device
// key for session delegations).
func Sign[T signable](obj T, priv ed25519.PrivateKey) error {
	msg, err := signingBytes(obj)
	if err != nil {
		return err
	}
	sig := ed25519.Sign(priv, msg)
	switch o := any(obj).(type) {
	case *IdentityAttestation:
		o.Sig = sig
	case *DeviceDelegation:
		o.Sig = sig
	case *SessionDelegation:
		o.Sig = sig
	case *DeviceRevoke:
		o.Sig = sig
	}
	return nil
}

// verifySig checks obj.Sig against signerPub over the object's signing bytes.
func verifySig[T signable](obj T, signerPub ed25519.PublicKey, sig []byte) bool {
	if len(signerPub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return false
	}
	msg, err := signingBytes(obj)
	if err != nil {
		return false
	}
	return ed25519.Verify(signerPub, msg, sig)
}

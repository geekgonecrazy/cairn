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

// Object type tags. These are part of the SIGNED bytes of every identity-log
// object, which does two things:
//
//  1. Parsing is deterministic — read `type`, dispatch. No decoding an object as
//     each candidate shape and keeping whichever happens to verify.
//  2. Signatures are domain-separated — a signature over a session delegation
//     can never verify as a device delegation, because the tag is inside what
//     was signed. Cross-type confusion requires forging Ed25519 rather than
//     merely finding two shapes whose canonical encodings collide.
//
// Before this, discrimination relied on re-encoded field sets differing between
// types — true of the current layout, but an accident of it. See decisions.md
// §Typed identity-log objects.
const (
	TypeAttestation       = "identity_attestation"
	TypeDeviceDelegation  = "device_delegation"
	TypeSessionDelegation = "session_delegation"
	TypeDeviceRevoke      = "device_revoke"
)

// typeHeader decodes just the discriminator, so a carrier can dispatch without
// speculatively decoding the whole object as every known shape.
type typeHeader struct {
	Type string `cbor:"type"`
}

// ObjectType reports the declared type tag of a CBOR identity-log object. The
// tag is untrusted until the object's signature verifies — it says what the
// bytes CLAIM to be, which is exactly what a dispatcher needs.
func ObjectType(blob []byte) (string, error) {
	var h typeHeader
	if err := cbor.Unmarshal(blob, &h); err != nil {
		return "", fmt.Errorf("identity: undecodable object: %w", err)
	}
	if h.Type == "" {
		return "", fmt.Errorf("identity: object has no type tag")
	}
	return h.Type, nil
}

// IdentityAttestation binds a member-root pubkey to a household root (origin).
// Signed by the household root. kind and origin are IMMUTABLE.
type IdentityAttestation struct {
	Type        string `cbor:"type"` // always TypeAttestation; signed
	Pubkey      []byte `cbor:"pubkey"`
	Kind        Kind   `cbor:"kind"`
	Origin      []byte `cbor:"origin"`      // household root pubkey; also the household id
	OperatedBy  []byte `cbor:"operated_by"` // for agents: the human member root, else nil
	DisplayName string `cbor:"display_name"`
	IssuedAt    int64  `cbor:"issued_at"` // unix ms
	Sig         []byte `cbor:"sig"`
}

// DeviceDelegation authorizes a device/instance key under its PARENT, which is
// either a member root (the member's first device) or another device key (any
// device paired from an existing one). Signed by the parent.
//
// Devices therefore form a TREE per member, not a flat list under the member
// root. That is what lets the member root stay offline — it signs the first
// delegation and is then put away — and what makes revocation cascade: a walk
// from a leaf passes through every ancestor, so revoking one device invalidates
// everything paired from it without naming any descendant.
type DeviceDelegation struct {
	Type      string `cbor:"type"` // always TypeDeviceDelegation; signed
	DevicePub []byte `cbor:"device_pub"`
	ParentPub []byte `cbor:"parent_pub"` // member root, or the device that paired this one
	IssuedAt  int64  `cbor:"issued_at"`            // unix ms
	ExpiresAt int64  `cbor:"expires_at,omitempty"` // unix ms; 0 = no expiry
	Sig       []byte `cbor:"sig"`
}

// SessionDelegation authorizes a short-lived session key under a device key.
// Browser only; signed by the device key (a WebAuthn passkey). Verifiers accept
// the WebAuthn signature envelope for the Sig — see PROTOCOL.md §2.3.
type SessionDelegation struct {
	Type       string `cbor:"type"` // always TypeSessionDelegation; signed
	SessionPub []byte `cbor:"session_pub"`
	DevicePub  []byte `cbor:"device_pub"`
	Scope      string `cbor:"scope"`
	ExpiresAt  int64  `cbor:"expires_at"` // unix ms
	Sig        []byte `cbor:"sig"`
}

// DeviceRevoke revokes a device delegation, signed by RevokerPub.
//
// A revoke binds only if the revoker is an ANCESTOR of the revoked device — its
// parent, its grandparent, or the member root at the top. Peers cannot revoke
// each other: otherwise a stolen phone could revoke the laptop above it, which
// would destroy the owner's access permanently (revoked keys can never be
// re-paired) while the thief kept theirs. A compromised device may damage only
// what it was already responsible for. VerifySender enforces this.
type DeviceRevoke struct {
	Type       string `cbor:"type"` // always TypeDeviceRevoke; signed
	DevicePub  []byte `cbor:"device_pub"`
	RevokerPub []byte `cbor:"revoker_pub"` // must be an ancestor of DevicePub
	RevokedAt  int64  `cbor:"revoked_at"`  // unix ms
	Sig        []byte `cbor:"sig"`
}

// signable is any identity-log object that carries a detached Ed25519 signature
// over its own deterministic-CBOR content (with the signature field cleared).
type signable interface {
	*IdentityAttestation | *DeviceDelegation | *SessionDelegation | *DeviceRevoke
}

// typeTagOf returns the canonical tag for a signable's Go type.
func typeTagOf[T signable](obj T) (string, error) {
	switch any(obj).(type) {
	case *IdentityAttestation:
		return TypeAttestation, nil
	case *DeviceDelegation:
		return TypeDeviceDelegation, nil
	case *SessionDelegation:
		return TypeSessionDelegation, nil
	case *DeviceRevoke:
		return TypeDeviceRevoke, nil
	default:
		return "", fmt.Errorf("identity: unsignable type %T", obj)
	}
}

// signingBytes returns the deterministic-CBOR of obj with its Sig cleared and
// its Type FORCED to the canonical tag for its Go type — so a caller cannot
// sign an object carrying somebody else's tag, and the tag is covered by the
// signature. Verification separately checks the stored tag matches (see
// checkTag): forcing it here alone would let a mislabelled blob verify while
// still claiming to be something it is not.
func signingBytes[T signable](obj T) ([]byte, error) {
	tag, err := typeTagOf(obj)
	if err != nil {
		return nil, err
	}
	switch o := any(obj).(type) {
	case *IdentityAttestation:
		c := *o
		c.Sig, c.Type = nil, tag
		return detCBOR.Marshal(&c)
	case *DeviceDelegation:
		c := *o
		c.Sig, c.Type = nil, tag
		return detCBOR.Marshal(&c)
	case *SessionDelegation:
		c := *o
		c.Sig, c.Type = nil, tag
		return detCBOR.Marshal(&c)
	case *DeviceRevoke:
		c := *o
		c.Sig, c.Type = nil, tag
		return detCBOR.Marshal(&c)
	default:
		return nil, fmt.Errorf("identity: unsignable type %T", obj)
	}
}

// checkTag reports whether obj's stored Type is the canonical tag for its Go
// type. Objects that arrive from the wire carry whatever tag the sender wrote;
// a mismatch means the bytes were decoded as the wrong shape.
func checkTag[T signable](obj T) bool {
	want, err := typeTagOf(obj)
	if err != nil {
		return false
	}
	switch o := any(obj).(type) {
	case *IdentityAttestation:
		return o.Type == want
	case *DeviceDelegation:
		return o.Type == want
	case *SessionDelegation:
		return o.Type == want
	case *DeviceRevoke:
		return o.Type == want
	default:
		return false
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
	tag, err := typeTagOf(obj)
	if err != nil {
		return err
	}
	sig := ed25519.Sign(priv, msg)
	// Stamp the canonical tag alongside the signature, so the in-memory object
	// matches the bytes that were signed.
	switch o := any(obj).(type) {
	case *IdentityAttestation:
		o.Sig, o.Type = sig, tag
	case *DeviceDelegation:
		o.Sig, o.Type = sig, tag
	case *SessionDelegation:
		o.Sig, o.Type = sig, tag
	case *DeviceRevoke:
		o.Sig, o.Type = sig, tag
	}
	return nil
}

// --- Exported self-verification --------------------------------------------
//
// Each object names the key that must have signed it, so it can be checked in
// isolation, with no resolver and no notion of which households are trusted.
// That is what lets a carrier (cairnd) refuse garbage without being an
// authority: it proves the bytes are internally consistent, nothing more.
//
// Verifying an object does NOT make its subject trusted — placing it in a
// household is VerifySender's job.

// VerifyAttestation checks an attestation against the household root it claims
// as its origin. NOTE: origin is self-declared; a valid signature here means
// "some household signed this", not "your household signed this".
func VerifyAttestation(a *IdentityAttestation) bool {
	return a != nil && verifySig(a, a.Origin, a.Sig)
}

// VerifyDeviceDelegation checks a delegation against the parent that issued it
// — a member root for a first device, another device key otherwise. A valid
// signature means "this parent admitted this device", not "this parent had
// standing to"; placing the parent in a tree that reaches a trusted household
// root is VerifySender's job.
func VerifyDeviceDelegation(d *DeviceDelegation) bool {
	return d != nil && verifySig(d, d.ParentPub, d.Sig)
}

// VerifySessionDelegation checks a session delegation against its device key.
func VerifySessionDelegation(s *SessionDelegation) bool {
	return s != nil && verifySig(s, s.DevicePub, s.Sig)
}

// VerifyDeviceRevoke checks a revocation against the key that issued it. This
// proves only that the named revoker signed it — NOT that the revoker had any
// standing to revoke this device. Authority (the revoker must be an ancestor of
// the target) can only be decided against the delegation tree, which is why
// VerifySender re-checks and why a carrier must not treat storage as endorsement.
func VerifyDeviceRevoke(d *DeviceRevoke) bool {
	return d != nil && verifySig(d, d.RevokerPub, d.Sig)
}

// verifySig checks obj.Sig against signerPub over the object's signing bytes.
//
// The type tag is checked FIRST: an object decoded as the wrong shape is
// rejected on the tag, before any signature work. This is what makes cross-type
// confusion structurally impossible rather than merely unlikely.
func verifySig[T signable](obj T, signerPub ed25519.PublicKey, sig []byte) bool {
	if !checkTag(obj) {
		return false
	}
	if len(signerPub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return false
	}
	msg, err := signingBytes(obj)
	if err != nil {
		return false
	}
	return ed25519.Verify(signerPub, msg, sig)
}

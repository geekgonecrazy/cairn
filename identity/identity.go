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
// by their BLAKE3-256 hash. See docs/protocol.md §1.
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
// names from docs/protocol.md §1; deterministic encoding sorts them canonically.
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
// types — true of the current layout, but an accident of it. See docs/adrs/0013-pubkey-identity-no-household.md
// §Typed identity-log objects.
const (
	TypeAttestation       = "identity_attestation"
	TypeDeviceDelegation  = "device_delegation"
	TypeSessionDelegation = "session_delegation"
	TypeDeviceRevoke      = "device_revoke"
	TypeAgentDelegation   = "agent_delegation"
	TypeVouchWithdraw     = "vouch_withdraw"
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

// IdentityAttestation is a member's self-signed profile: it binds a member key to
// its kind, display name, and (for agents) operating human. Signed by the member
// key ITSELF — there is no household root in the v2 trust model. kind is immutable
// once published; the display name is a self-asserted label whose weight a peer
// decides (docs §Trust model v2: verification tiers).
type IdentityAttestation struct {
	Type        string `cbor:"type"` // always TypeAttestation; signed
	Pubkey      []byte `cbor:"pubkey"`
	Kind        Kind   `cbor:"kind"`
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
// the WebAuthn signature envelope for the Sig — see docs/protocol.md §2.3.
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
// A revoke binds only if the revoker is an ANCESTOR of its target — its
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

// AgentDelegation is a human's vouch for an agent: "this agent is mine".
// Signed by the DELEGATOR, a device key in the operator's tree — never by the
// member root a browser doesn't hold, and never by the agent itself (a
// self-declared operated_by proves nothing; see docs/adrs/0017-agent-delegation.md).
//
// The vouch NAMES the operator it delegates to (OperatorPub), and validates
// only while that equals the agent's attested operated_by. That is what makes
// transfer safe: the agent re-attests to a new operator, the new operator
// vouches, and old vouches void automatically — nobody can vouch an agent to
// someone it did not name, so ownership is never ambiguous and never stealable.
//
// The delegator must resolve to the operator (walk + revocation checks) or BE
// the operator root (a durable, words-signed vouch the cascade cannot touch).
// Revoking the delegator's device removes only this vouch, never the agent —
// an agent survives while ANY vouch survives, which is what lets a human vouch
// from every live device instead of betting the agent on one.
type AgentDelegation struct {
	Type         string `cbor:"type"` // always TypeAgentDelegation; signed
	AgentPub     []byte `cbor:"agent_pub"`
	DelegatorPub []byte `cbor:"delegator_pub"` // the vouching device key
	OperatorPub  []byte `cbor:"operator_pub"`  // must equal the attested operated_by
	IssuedAt     int64  `cbor:"issued_at"`     // unix ms
	ExpiresAt    int64  `cbor:"expires_at,omitempty"` // unix ms; 0 = no expiry
	Sig          []byte `cbor:"sig"`
}

// VouchWithdraw retires the delegator's OWN vouch for an agent, signed by the
// delegator itself. Self-withdrawal needs no authority proof — a device
// withdrawing its own vouch is uncontroversial — which is why killing an agent
// needs no member-root words: withdraw every vouch and the agent is unproven
// with no path back by itself. A withdraw kills vouches issued at or before
// WithdrawnAt; a later re-vouch from the same delegator is live again, so an
// operator can always re-prove (no lockout).
type VouchWithdraw struct {
	Type         string `cbor:"type"` // always TypeVouchWithdraw; signed
	AgentPub     []byte `cbor:"agent_pub"`
	DelegatorPub []byte `cbor:"delegator_pub"` // the vouch being withdrawn; also the signer
	WithdrawnAt  int64  `cbor:"withdrawn_at"`  // unix ms
	Sig          []byte `cbor:"sig"`
}

// signable is any identity-log object that carries a detached Ed25519 signature
// over its own deterministic-CBOR content (with the signature field cleared).
type signable interface {
	*IdentityAttestation | *DeviceDelegation | *SessionDelegation | *DeviceRevoke |
		*AgentDelegation | *VouchWithdraw
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
	case *AgentDelegation:
		return TypeAgentDelegation, nil
	case *VouchWithdraw:
		return TypeVouchWithdraw, nil
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
	case *AgentDelegation:
		c := *o
		c.Sig, c.Type = nil, tag
		return detCBOR.Marshal(&c)
	case *VouchWithdraw:
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
	case *AgentDelegation:
		return o.Type == want
	case *VouchWithdraw:
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
	case *AgentDelegation:
		o.Sig, o.Type = sig, tag
	case *VouchWithdraw:
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

// VerifyAttestation checks a self-attestation against the member key that signed
// it (the same key it names). A valid signature proves the profile was authored
// by the holder of that key — NOT that you should trust the key, which is an edge
// decision (see VerifySender and docs §Trust model v2).
func VerifyAttestation(a *IdentityAttestation) bool {
	return a != nil && verifySig(a, a.Pubkey, a.Sig)
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

// VerifyAgentDelegation checks a vouch against the delegator device that signed
// it. This proves only that the named delegator vouched for this agent — NOT
// that the delegator belongs to the named operator, and NOT that the agent
// still names that operator. Both are decided against the trees at verify time
// (see AgentVouchProof): a vouch is a claim the verifier re-places, never a
// fact it inherits from storage.
func VerifyAgentDelegation(d *AgentDelegation) bool {
	return d != nil && verifySig(d, d.DelegatorPub, d.Sig)
}

// VerifyVouchWithdraw checks a withdrawal against the delegator withdrawing its
// own vouch. Self-withdrawal is the only valid shape — a withdraw signed by
// anyone else names a signer that is not its subject and every verifier
// ignores it.
func VerifyVouchWithdraw(w *VouchWithdraw) bool {
	return w != nil && verifySig(w, w.DelegatorPub, w.Sig)
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

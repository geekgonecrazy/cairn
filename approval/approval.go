// Package approval implements Cairn's half of the capability-approval flow:
// **portable signed artifacts**. Cairn delivers a capability request to a human,
// captures the human's signature, and hands back an artifact the agent carries
// OUT of Cairn to the capability broker to exchange for a token.
//
// The broker is NOT a Cairn component — it is a Capsule workload in the agents
// system that mints attenuated, time-boxed JWTs (systems/agents/framework.md
// §"Approval = the credential broker"). Cairn never verifies policy, mints
// credentials, or keeps a consumed-id cache. Per that doc: *"the room is the
// delivery medium, not the capability boundary."*
//
// So every artifact here is signed over its OWN canonical deterministic-CBOR —
// not merely the room event envelope — which is what makes it portable: it
// verifies standalone, outside Cairn, with no room key and no identity log.
//
// The signature IS the authority: "there is no 'trust the room sender' MVP path
// in this model — signed-statement is structurally required (the agent must
// physically present the approver's signature to mint)."
package approval

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"fmt"

	"lukechampine.com/blake3"

	"github.com/geekgonecrazy/cairn/identity"
)

// Errors from verification and binding checks.
var (
	ErrBadSignature    = errors.New("approval: signature does not verify")
	ErrRequestMismatch = errors.New("approval: grant does not cover this request")
	ErrAgentMismatch   = errors.New("approval: grant is bound to a different agent")
)

// PayloadTypeCapability tags a payload whose bytes are a deterministic-CBOR
// Capability (below). It is the one payload type Cairn itself ships, but the
// envelope is deliberately generic: an approval carries an OPAQUE payload plus a
// `payload_type` saying how to read it, and binds to it by hash. A different
// system (e.g. an agent framework's own capability schema) puts its own bytes in
// the payload under its own type; Cairn moves and witnesses them without needing
// to understand them, and the broker parses the payload per its declared type.
const PayloadTypeCapability = "cairn.capability.v1"

// Capability is Cairn's standard payload: what is being asked for. It is carried
// inside the request's opaque `payload`, and its hash is the binding value the
// grant commits to, so a grant cannot be silently retargeted to a different
// action. The human-readable `Scope` lives INSIDE the payload — so it is covered
// by the hash the approver signs, never displayed alongside it unsigned.
type Capability struct {
	Name   string            `cbor:"name"`             // e.g. "vent.actuate"
	Params map[string]string `cbor:"params,omitempty"` // e.g. {"target": "gh_roof"}
	Scope  string            `cbor:"scope,omitempty"`  // human-readable, shown in the inlay
	TaskID string            `cbor:"task_id,omitempty"`
}

// HashPayload is BLAKE3-256 over a payload's exact bytes — the `payload_hash`
// both sides bind to. The bytes are hashed as-is and never re-encoded, so the
// commitment is stable across the request, the grant, and the broker.
func HashPayload(payload []byte) [32]byte { return blake3.Sum256(payload) }

// MarshalCapability encodes a Capability as an approval payload: its type tag and
// its deterministic-CBOR bytes, ready to hand to NewRequest.
func MarshalCapability(c *Capability) (payloadType string, payload []byte, err error) {
	b, err := identity.Marshal(c)
	if err != nil {
		return "", nil, err
	}
	return PayloadTypeCapability, b, nil
}

// UnmarshalCapability decodes a Capability payload. It errors on any other
// payload_type rather than guessing — a caller that gets an error knows the
// payload is something it does not understand, not an empty capability.
func UnmarshalCapability(payloadType string, payload []byte) (*Capability, error) {
	if payloadType != PayloadTypeCapability {
		return nil, fmt.Errorf("approval: payload_type %q is not a capability", payloadType)
	}
	var c Capability
	if err := identity.Unmarshal(payload, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// HashCapability is BLAKE3-256 over a capability's deterministic CBOR — a
// convenience over MarshalCapability + HashPayload.
func HashCapability(c *Capability) ([32]byte, error) {
	_, b, err := MarshalCapability(c)
	if err != nil {
		return [32]byte{}, err
	}
	return HashPayload(b), nil
}

// Artifact type tags, part of each artifact's SIGNED bytes.
//
// Inside Cairn the event envelope already says what an artifact is — but a
// Grant's whole purpose is to verify STANDALONE, outside Cairn, with no room
// key and no envelope (Phase 2 exit criterion). A broker holding a bare blob is
// in exactly the position the carrier was: it must not have to guess. Tagging
// inside the signature means a Deny can never be re-read as a Grant, which on
// this path would be the difference between refusing and minting a credential.
const (
	TypeRequest = "approval_request"
	TypeGrant   = "approval_grant"
	TypeDeny    = "approval_deny"
)

// typeHeader decodes just the discriminator so a broker can dispatch.
type typeHeader struct {
	Type string `cbor:"type"`
}

// ArtifactType reports the declared type tag of a CBOR approval artifact. The
// tag is untrusted until the signature verifies — it says what the bytes CLAIM
// to be, which is what a dispatcher needs.
func ArtifactType(blob []byte) (string, error) {
	var h typeHeader
	if err := identity.Unmarshal(blob, &h); err != nil {
		return "", fmt.Errorf("approval: undecodable artifact: %w", err)
	}
	if h.Type == "" {
		return "", fmt.Errorf("approval: artifact has no type tag")
	}
	return h.Type, nil
}

// Request is the agent's signed ask, emitted into the room as approval_request.
// Signed by the agent's own device key. It carries an OPAQUE payload plus a
// `payload_type` describing it and a `payload_hash` committing to it — all inside
// the signed bytes, so a verifier that trusts the signature can trust the label.
type Request struct {
	Type        string `cbor:"type"` // always TypeRequest; signed
	RequestID   []byte `cbor:"request_id"`
	AgentPub    []byte `cbor:"agent_pub"`
	PayloadType string `cbor:"payload_type"` // how to read Payload (e.g. PayloadTypeCapability)
	Payload     []byte `cbor:"payload"`      // opaque; the thing being asked for
	PayloadHash []byte `cbor:"payload_hash"` // BLAKE3 over Payload; the grant's binding value
	IssuedAt    int64  `cbor:"issued_at"`    // unix ms
	ExpiresAt   int64  `cbor:"expires_at"`   // unix ms; mandatory — nothing parks forever
	Sig         []byte `cbor:"sig"`
}

// Grant is THE deliverable: the human's signed approval. Request-bound
// (request_id + payload_hash) and agent-bound (agent_pub) so it cannot be
// replayed by a different agent for a different action. It commits to the payload
// by hash, not by value — the payload travels in the request the agent presents
// alongside. Single-use enforcement (the consumed-id cache) is the broker's job.
type Grant struct {
	Type        string `cbor:"type"` // always TypeGrant; signed
	RequestID   []byte `cbor:"request_id"`
	PayloadHash []byte `cbor:"payload_hash"`
	AgentPub    []byte `cbor:"agent_pub"`
	ApproverPub []byte `cbor:"approver_pub"`
	IssuedAt    int64  `cbor:"issued_at"`
	ExpiresAt   int64  `cbor:"expires_at"`
	Sig         []byte `cbor:"sig"`
}

// Deny closes the loop negatively. Timeout-driven denial is the absence of a
// grant before ExpiresAt.
type Deny struct {
	Type        string `cbor:"type"` // always TypeDeny; signed
	RequestID   []byte `cbor:"request_id"`
	ApproverPub []byte `cbor:"approver_pub"`
	Reason      string `cbor:"reason,omitempty"`
	IssuedAt    int64  `cbor:"issued_at"`
	Sig         []byte `cbor:"sig"`
}

// CredentialMinted is emitted back into the room BY THE BROKER once it has
// minted. Cairn only decodes and displays it — it never produces one.
type CredentialMinted struct {
	RequestID []byte `cbor:"request_id"`
	IssuedAt  int64  `cbor:"issued_at"`
	ExpiresAt int64  `cbor:"expires_at,omitempty"`
}

// artifact is any of our self-signed portable statements.
type artifact interface {
	*Request | *Grant | *Deny
}

// signingBytes is the deterministic CBOR of the artifact with Sig cleared —
// exactly what the signer signs and any verifier recomputes. Because it covers
// only the artifact's own fields, verification needs nothing from Cairn.
func signingBytes[T artifact](a T) ([]byte, error) {
	tag, err := typeTagOf(a)
	if err != nil {
		return nil, err
	}
	switch v := any(a).(type) {
	case *Request:
		c := *v
		c.Sig, c.Type = nil, tag
		return identity.Marshal(&c)
	case *Grant:
		c := *v
		c.Sig, c.Type = nil, tag
		return identity.Marshal(&c)
	case *Deny:
		c := *v
		c.Sig, c.Type = nil, tag
		return identity.Marshal(&c)
	default:
		return nil, fmt.Errorf("approval: unsignable type %T", a)
	}
}

// typeTagOf returns the canonical tag for an artifact's Go type.
func typeTagOf[T artifact](a T) (string, error) {
	switch any(a).(type) {
	case *Request:
		return TypeRequest, nil
	case *Grant:
		return TypeGrant, nil
	case *Deny:
		return TypeDeny, nil
	default:
		return "", fmt.Errorf("approval: unsignable type %T", a)
	}
}

// checkTag reports whether a's stored Type is canonical for its Go type. An
// artifact off the wire carries whatever tag its sender wrote; a mismatch means
// the bytes were decoded as the wrong shape.
func checkTag[T artifact](a T) bool {
	want, err := typeTagOf(a)
	if err != nil {
		return false
	}
	switch v := any(a).(type) {
	case *Request:
		return v.Type == want
	case *Grant:
		return v.Type == want
	case *Deny:
		return v.Type == want
	default:
		return false
	}
}

// Sign fills the artifact's Sig using priv (the agent's key for a Request, the
// approver's key for a Grant/Deny).
func Sign[T artifact](a T, priv ed25519.PrivateKey) error {
	msg, err := signingBytes(a)
	if err != nil {
		return err
	}
	tag, err := typeTagOf(a)
	if err != nil {
		return err
	}
	sig := ed25519.Sign(priv, msg)
	switch v := any(a).(type) {
	case *Request:
		v.Sig, v.Type = sig, tag
	case *Grant:
		v.Sig, v.Type = sig, tag
	case *Deny:
		v.Sig, v.Type = sig, tag
	}
	return nil
}

// verify checks an artifact's own signature against signerPub.
func verify[T artifact](a T, signerPub, sig []byte) error {
	// Tag first: an artifact decoded as the wrong shape is rejected before any
	// signature work, so a Deny can never be verified as a Grant.
	if !checkTag(a) {
		return ErrBadSignature
	}
	if len(signerPub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return ErrBadSignature
	}
	msg, err := signingBytes(a)
	if err != nil {
		return err
	}
	if !ed25519.Verify(signerPub, msg, sig) {
		return ErrBadSignature
	}
	return nil
}

// VerifyRequest checks the agent's signature on its own ask.
func VerifyRequest(r *Request) error { return verify(r, r.AgentPub, r.Sig) }

// VerifyGrant checks the approver's signature. This is the standalone check a
// broker performs — it needs only the artifact and the approver's pubkey.
func VerifyGrant(g *Grant) error { return verify(g, g.ApproverPub, g.Sig) }

// VerifyDeny checks the approver's signature on a denial.
func VerifyDeny(d *Deny) error { return verify(d, d.ApproverPub, d.Sig) }

// Expired reports whether the artifact is past its expiry at now (unix ms).
func (r *Request) Expired(now int64) bool { return r.ExpiresAt != 0 && now > r.ExpiresAt }
func (g *Grant) Expired(now int64) bool   { return g.ExpiresAt != 0 && now > g.ExpiresAt }

// GrantCovers checks the binding between a grant and the request it approves:
// same request_id, the capability hash matches, and the grant names the same
// agent. This is a pure structural check, NOT policy — policy (who may approve
// what) and replay defence live in the broker. Exposed so a client can prove to
// itself that what it is about to sign matches what it was shown, and so tests
// can demonstrate portability.
func GrantCovers(g *Grant, r *Request) error {
	if !bytes.Equal(g.RequestID, r.RequestID) {
		return ErrRequestMismatch
	}
	if !bytes.Equal(g.PayloadHash, r.PayloadHash) {
		return ErrRequestMismatch
	}
	if !bytes.Equal(g.AgentPub, r.AgentPub) {
		return ErrAgentMismatch
	}
	return nil
}

// NewRequest builds and signs an agent's request over an opaque payload,
// computing the payload hash for the caller. The payload bytes are hashed as-is
// and never re-encoded.
func NewRequest(requestID []byte, agent identity.KeyPair, payloadType string, payload []byte, issuedAt, expiresAt int64) (*Request, error) {
	h := HashPayload(payload)
	r := &Request{
		RequestID:   requestID,
		AgentPub:    agent.Pub,
		PayloadType: payloadType,
		Payload:     payload,
		PayloadHash: h[:],
		IssuedAt:    issuedAt,
		ExpiresAt:   expiresAt,
	}
	if err := Sign(r, agent.Priv); err != nil {
		return nil, err
	}
	return r, nil
}

// NewCapabilityRequest is the convenience for Cairn's standard payload: it
// encodes the Capability, tags it, and builds the request.
func NewCapabilityRequest(requestID []byte, agent identity.KeyPair, cap *Capability, issuedAt, expiresAt int64) (*Request, error) {
	pt, payload, err := MarshalCapability(cap)
	if err != nil {
		return nil, err
	}
	return NewRequest(requestID, agent, pt, payload, issuedAt, expiresAt)
}

// Approve produces the human's signed grant for a request. The caller should
// have verified the request and shown the human its capability and scope first.
func Approve(r *Request, approver identity.KeyPair, issuedAt, expiresAt int64) (*Grant, error) {
	g := &Grant{
		RequestID:   r.RequestID,
		PayloadHash: r.PayloadHash,
		AgentPub:    r.AgentPub,
		ApproverPub: approver.Pub,
		IssuedAt:    issuedAt,
		ExpiresAt:   expiresAt,
	}
	if err := Sign(g, approver.Priv); err != nil {
		return nil, err
	}
	return g, nil
}

// Refuse produces the human's signed denial for a request.
func Refuse(r *Request, approver identity.KeyPair, reason string, issuedAt int64) (*Deny, error) {
	d := &Deny{
		RequestID:   r.RequestID,
		ApproverPub: approver.Pub,
		Reason:      reason,
		IssuedAt:    issuedAt,
	}
	if err := Sign(d, approver.Priv); err != nil {
		return nil, err
	}
	return d, nil
}

// Encode / Decode are the portable wire form of an artifact: deterministic CBOR.
// An approval_* event payload IS this encoding — so an agent that decrypts the
// room event holds the portable artifact directly, ready for the broker.
func Encode(v any) ([]byte, error) { return identity.Marshal(v) }

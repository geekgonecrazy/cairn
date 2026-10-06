package identity

import (
	"bytes"
	"crypto/ed25519"
	"fmt"
)

// Agent vouches: a human's devices vouch for the agent's member key, which is
// what turns the agent's self-declared operated_by into a proven fact. See
// docs/adrs/0017-agent-delegation.md.
//
// The agent is NOT in the operator's device tree — it is its own member with
// its own attestation, name, and rooms — so nothing done to a device cascades
// into it. A vouch is attribution, not authority: revoking the delegator
// removes one vouch, and the agent survives while any vouch survives.

// IssueAgentVouch mints the vouch by which a device vouches an agent to its
// operator: "device D (mine) says agent A belongs to operator O". Signed by
// the delegator's key — the member root is never needed, so this runs from any
// logged-in device with no words.
//
// operatorPub names the member root the delegator must resolve to. It MUST be
// the agent's attested operated_by at verify time; a vouch that names anyone
// else is void. That is the whole transfer story: the agent re-attests, the
// new operator vouches, and old vouches stop matching on their own.
func IssueAgentVouch(
	agentPub, delegatorPub PubKey,
	delegatorPriv ed25519.PrivateKey,
	operatorPub PubKey,
	issuedAt, expiresAt int64,
) (*AgentDelegation, error) {
	if len(agentPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: agent pubkey must be %d bytes", ed25519.PublicKeySize)
	}
	if len(delegatorPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: delegator pubkey must be %d bytes", ed25519.PublicKeySize)
	}
	if len(operatorPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: operator pubkey must be %d bytes", ed25519.PublicKeySize)
	}
	if bytes.Equal(agentPub, delegatorPub) {
		return nil, fmt.Errorf("identity: a key cannot vouch itself as an agent")
	}
	if expiresAt != 0 && expiresAt <= issuedAt {
		return nil, fmt.Errorf("identity: vouch expires_at must be after issued_at")
	}
	d := &AgentDelegation{
		AgentPub:     append([]byte(nil), agentPub...),
		DelegatorPub: append([]byte(nil), delegatorPub...),
		OperatorPub:  append([]byte(nil), operatorPub...),
		IssuedAt:     issuedAt,
		ExpiresAt:    expiresAt,
	}
	if err := Sign(d, delegatorPriv); err != nil {
		return nil, fmt.Errorf("identity: sign agent delegation: %w", err)
	}
	return d, nil
}

// WithdrawVouch mints the delegator's withdrawal of its OWN vouch for an
// agent. Signed by the delegator itself — self-withdrawal is the only valid
// shape, so minting with anyone else's key produces an object every verifier
// ignores. Withdrawing every vouch un-proves the agent with no path back by
// itself; a later re-vouch (issued after the withdrawal) is live again.
func WithdrawVouch(
	agentPub, delegatorPub PubKey,
	delegatorPriv ed25519.PrivateKey,
	withdrawnAt int64,
) (*VouchWithdraw, error) {
	if len(agentPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: agent pubkey must be %d bytes", ed25519.PublicKeySize)
	}
	if len(delegatorPub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("identity: delegator pubkey must be %d bytes", ed25519.PublicKeySize)
	}
	w := &VouchWithdraw{
		AgentPub:     append([]byte(nil), agentPub...),
		DelegatorPub: append([]byte(nil), delegatorPub...),
		WithdrawnAt:  withdrawnAt,
	}
	if err := Sign(w, delegatorPriv); err != nil {
		return nil, fmt.Errorf("identity: sign vouch withdrawal: %w", err)
	}
	return w, nil
}

// CurrentAttestation selects the one attestation that speaks for a member out
// of every self-attestation that member ever published — the rule every
// replica applies to the same set, so all converge without coordination:
//
//   - The profile (name, operated_by, …) comes from the LATEST issued_at; ties
//     break toward the greatest content hash. Re-attesting (rename, transfer)
//     therefore supersedes; a bad clock can only stop an agent superseding its
//     own past, never lock anyone else out.
//   - kind is earliest-issued-wins (ties toward the smallest hash): kind is
//     immutable, so the first statement defines it, and rejecting later
//     conflicts at insert would be order-dependent across replicas.
//
// Returns nil on an empty set.
func CurrentAttestation(cands []*IdentityAttestation) *IdentityAttestation {
	if len(cands) == 0 {
		return nil
	}
	// Earliest issuance defines the kind.
	kind := cands[0].Kind
	earliest, earliestHash := cands[0].IssuedAt, mustHash(cands[0])
	for _, c := range cands[1:] {
		h := mustHash(c)
		if c.IssuedAt < earliest || (c.IssuedAt == earliest && bytes.Compare(h[:], earliestHash[:]) < 0) {
			earliest, earliestHash, kind = c.IssuedAt, h, c.Kind
		}
	}
	// Latest issuance carries the profile.
	profile := cands[0]
	profileHash := mustHash(profile)
	for _, c := range cands[1:] {
		h := mustHash(c)
		if c.IssuedAt > profile.IssuedAt ||
			(c.IssuedAt == profile.IssuedAt && bytes.Compare(h[:], profileHash[:]) > 0) {
			profile, profileHash = c, h
		}
	}
	if profile.Kind == kind {
		return profile
	}
	// The profile is newer than the kind's first statement: keep the immutable
	// kind, take everything else from the latest profile.
	out := *profile
	out.Kind = kind
	return &out
}

// mustHash is Hash that treats an encoding failure as zero — attestation
// selection must be total (every replica picks the same winner) even over a
// hostile object, and a nil hash still orders deterministically.
func mustHash(v any) (h [32]byte) {
	hh, err := Hash(v)
	if err != nil {
		return h
	}
	return hh
}

// agentVouchProof decides whether an agent's operated_by claim is proven: at
// least one vouch must survive — valid signature by its delegator, unexpired,
// naming the attested operator, from a delegator that resolves to that
// operator (or IS it), and not withdrawn or revoked out from under it.
//
// now is unix-ms wall-clock. Returns the proof state and the count of
// surviving vouches (so callers can say "vouched by N devices", and so a
// human re-vouching from a new device is visible, not just boolean).
func agentVouchProof(att *IdentityAttestation, r Resolver, now int64) (AgentProof, int) {
	if att == nil || att.Kind != KindAgent || len(att.OperatedBy) != ed25519.PublicKeySize {
		return AgentProofUnproven, 0
	}
	surviving := 0
	for _, d := range r.AgentDelegations(att.Pubkey) {
		if !vouchSurvives(d, att, r, now) {
			continue
		}
		surviving++
	}
	if surviving == 0 {
		return AgentProofUnproven, 0
	}
	return AgentProofProven, surviving
}

// vouchSurvives applies every liveness check to one candidate vouch. A vouch
// that fails ANY of these is not evidence of anything and is ignored rather
// than treated as a weaker signal — same doctrine as unauthorized revokes.
func vouchSurvives(d *AgentDelegation, att *IdentityAttestation, r Resolver, now int64) bool {
	if d == nil || !VerifyAgentDelegation(d) {
		return false
	}
	if !bytes.Equal(d.AgentPub, att.Pubkey) {
		return false // filed under the wrong subject; says nothing about this agent
	}
	if !bytes.Equal(d.OperatorPub, att.OperatedBy) {
		return false // names an operator the agent no longer claims (transfer voids it)
	}
	if d.ExpiresAt != 0 && now > d.ExpiresAt {
		return false
	}
	if vouchWithdrawn(d, r.VouchWithdraws(att.Pubkey)) {
		return false
	}
	if bytes.Equal(d.DelegatorPub, att.OperatedBy) {
		return true // root-signed: durable, words-issued; the cascade cannot touch it
	}
	// Otherwise the delegator must be a live device in the operator's tree:
	// walk it to the member root with revocation checked at every hop.
	chain, memberPub, err := walkDevices(d.DelegatorPub, r, now)
	if err != nil {
		return false
	}
	if !bytes.Equal(memberPub, att.OperatedBy) {
		return false // the delegator belongs to someone else's tree
	}
	if err := checkRevocations(chain, memberPub, r); err != nil {
		return false // the delegator (or something above it) was revoked
	}
	return true
}

// vouchWithdrawn reports whether any withdrawal covers vouch d: signed by the
// vouch's own delegator, naming this agent, and timestamped at or after the
// vouch's issuance. A withdraw kills vouches issued at or before it; a later
// re-vouch is live, so withdrawing can never permanently lock an operator out
// of re-proving.
func vouchWithdrawn(d *AgentDelegation, withdraws []*VouchWithdraw) bool {
	for _, w := range withdraws {
		if w == nil || !VerifyVouchWithdraw(w) {
			continue
		}
		if !bytes.Equal(w.AgentPub, d.AgentPub) || !bytes.Equal(w.DelegatorPub, d.DelegatorPub) {
			continue
		}
		if w.WithdrawnAt >= d.IssuedAt {
			return true
		}
	}
	return false
}

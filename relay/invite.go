package relay

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/fxamacker/cbor/v2"
)

const invitePrefix = "cairn:invite:1:"

// detCBOR is deterministic CBOR (RFC 8949 §4.2), so an invite's signing bytes are
// canonical on both the issuing and redeeming sides.
var detCBOR = func() cbor.EncMode {
	em, err := cbor.CoreDetEncOptions().EncMode()
	if err != nil {
		panic("relay: cbor det enc mode: " + err.Error())
	}
	return em
}()

// Invite is a single-use, relay-signed token. Redeeming one adds the redeemer's
// member key to the relay's allow-list. The signature is by the relay key; a
// redeemer verifies it against the relay pubkey it pinned. The ID is the
// single-use key — the relay records it as consumed on first redemption.
type Invite struct {
	ID        []byte `cbor:"id"`         // 16 random bytes
	ExpiresAt int64  `cbor:"expires_at"` // unix ms; 0 = no expiry
	Sig       []byte `cbor:"sig"`
}

// inviteSigningBytes are what the relay signs: the id and expiry, canonically
// encoded. The sig is excluded (it is derived from these).
func inviteSigningBytes(id []byte, expiresAt int64) []byte {
	b, _ := detCBOR.Marshal([]any{id, expiresAt})
	return b
}

// NewInvite mints and signs a fresh invite with the relay private key. expiresAt
// is unix-ms; pass 0 for a non-expiring invite.
func NewInvite(relayPriv ed25519.PrivateKey, expiresAt int64) (*Invite, error) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil, fmt.Errorf("relay: gen invite id: %w", err)
	}
	inv := &Invite{ID: id, ExpiresAt: expiresAt}
	inv.Sig = ed25519.Sign(relayPriv, inviteSigningBytes(id, expiresAt))
	return inv, nil
}

// Verify checks the invite's signature against the relay pubkey. It does NOT
// check expiry or consumption — the redeemer does that.
func (inv *Invite) Verify(relayPub ed25519.PublicKey) bool {
	if len(inv.ID) == 0 || len(inv.Sig) != ed25519.SignatureSize || len(relayPub) != ed25519.PublicKeySize {
		return false
	}
	return ed25519.Verify(relayPub, inviteSigningBytes(inv.ID, inv.ExpiresAt), inv.Sig)
}

// Encode renders the invite as cairn:invite:1:<base64url det-CBOR>.
func (inv *Invite) Encode() (string, error) {
	b, err := detCBOR.Marshal(inv)
	if err != nil {
		return "", err
	}
	return invitePrefix + base64.RawURLEncoding.EncodeToString(b), nil
}

// ParseInvite decodes an invite string. It validates structure only; the caller
// must Verify it against the relay pubkey and check expiry/consumption.
func ParseInvite(s string) (*Invite, error) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(s), invitePrefix)
	if !ok {
		return nil, fmt.Errorf("relay: not a Cairn invite")
	}
	b, err := base64.RawURLEncoding.DecodeString(rest)
	if err != nil {
		return nil, fmt.Errorf("relay: malformed invite: %w", err)
	}
	var inv Invite
	if err := cbor.Unmarshal(b, &inv); err != nil {
		return nil, fmt.Errorf("relay: undecodable invite: %w", err)
	}
	return &inv, nil
}

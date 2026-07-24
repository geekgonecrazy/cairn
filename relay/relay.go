// Package relay implements the relay's own identity and its access model: the
// relay keypair (persisted; clients pin it), an allow-list of member roots the
// relay will carry, and single-use invite tokens the operator hands out to admit
// new members.
//
// This is OPERATIONAL admission — who may USE this relay — and is deliberately
// separate from identity trust, which stays per-key at the edge (pairing / a
// shared room). A relay that carries you is not a relay that vouches for who you
// are. See docs/adrs/0014-relay-operational-admission.md.
package relay

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"

	"github.com/geekgonecrazy/cairn/store"
)

// metaRelaySeed is the meta-table key holding the relay's Ed25519 seed. Persisted
// so the relay keeps the same identity across restarts — clients pin its pubkey.
const metaRelaySeed = "relay_seed"

// LoadOrCreateKey returns the relay's Ed25519 keypair, generating and persisting
// a fresh seed the first time. The relay pubkey is what clients pin to know they
// are talking to the right relay, and what invite tokens are signed under.
func LoadOrCreateKey(st store.Store) (ed25519.PublicKey, ed25519.PrivateKey, error) {
	if v, ok, err := st.GetMeta(metaRelaySeed); err != nil {
		return nil, nil, err
	} else if ok {
		seed, err := hex.DecodeString(v)
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, nil, fmt.Errorf("relay: stored seed is invalid")
		}
		priv := ed25519.NewKeyFromSeed(seed)
		return priv.Public().(ed25519.PublicKey), priv, nil
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, nil, fmt.Errorf("relay: gen seed: %w", err)
	}
	if err := st.PutMeta(metaRelaySeed, hex.EncodeToString(seed)); err != nil {
		return nil, nil, err
	}
	priv := ed25519.NewKeyFromSeed(seed)
	return priv.Public().(ed25519.PublicKey), priv, nil
}

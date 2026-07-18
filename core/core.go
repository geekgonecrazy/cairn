// Package core wires Cairn together and holds the process's live state, in the
// rfd-tool/flockledger style: core.Setup() initializes unexported package-level
// singletons (the store, the realtime hub, the trusted-root set); everything
// else calls exported functions here rather than passing handles around.
package core

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"log"

	"github.com/geekgonecrazy/cairn/blobs"
	"github.com/geekgonecrazy/cairn/blobs/local"
	"github.com/geekgonecrazy/cairn/config"
	"github.com/geekgonecrazy/cairn/store"
	"github.com/geekgonecrazy/cairn/store/sqlite"
)

// metaHouseholdRoot is the meta-table key under which an adopted household root
// is persisted, so a carrier that founded a household stays bound to it across
// restarts rather than re-opening the founding window.
const metaHouseholdRoot = "household_root"

var (
	st        store.Store
	blobStore blobs.Backend
	hub       *Hub

	// Chain-gate trust anchors. `configuredRoots` come from config and are fixed.
	// `adoptedRoot` is learned at founding (the first attestation this carrier
	// stores) and persisted. Adoption is allowed ONLY when no roots are
	// configured — a configured carrier has a fixed, operator-chosen anchor set
	// and never auto-trusts a household it happened to meet first.
	configuredRoots [][]byte
	adoptedRoot     []byte
	allowAdoption   bool
)

// Setup selects and opens the store, creates the schema, builds the realtime
// hub, and decodes the configured trusted household roots. Call after
// config.Load and before router.Start.
func Setup() error {
	switch config.Config.Store {
	case "", "sqlite":
		s, err := sqlite.New(config.Config.SqlitePath)
		if err != nil {
			return err
		}
		if err := s.CheckDb(); err != nil {
			return err
		}
		st = s
	default:
		return fmt.Errorf("core: unknown store backend %q", config.Config.Store)
	}

	// Data plane. NOTE: this is the local filesystem backend standing in for
	// iroh-store — see decisions.md §Deviations. Swapping in blobs/iroh here is
	// the only change needed above the Backend interface.
	bs, err := local.New(config.Config.BlobDir)
	if err != nil {
		return err
	}
	blobStore = bs

	hub = newHub()

	configuredRoots = nil
	for _, h := range config.Config.TrustedRoots {
		b, err := hex.DecodeString(h)
		if err != nil {
			return fmt.Errorf("core: bad trustedRoots hex %q: %w", h, err)
		}
		if len(b) != ed25519.PublicKeySize {
			return fmt.Errorf("core: trustedRoots entry %q is not a 32-byte pubkey", h)
		}
		configuredRoots = append(configuredRoots, b)
	}

	// Adoption is the founding window: it opens only when the operator has NOT
	// pinned roots in config. A pinned carrier is strict from t=0.
	allowAdoption = len(configuredRoots) == 0
	adoptedRoot = nil
	if allowAdoption {
		if v, ok, err := st.GetMeta(metaHouseholdRoot); err != nil {
			return err
		} else if ok {
			b, err := hex.DecodeString(v)
			if err != nil || len(b) != ed25519.PublicKeySize {
				return fmt.Errorf("core: stored household root %q is invalid", v)
			}
			adoptedRoot = b
		}
	}

	switch {
	case len(configuredRoots) > 0:
		log.Printf("chain gate: ENFORCING against %d configured household root(s)", len(configuredRoots))
	case len(adoptedRoot) == ed25519.PublicKeySize:
		log.Printf("chain gate: ENFORCING against adopted household root %x", adoptedRoot)
	default:
		log.Printf("chain gate: awaiting founding — no household root yet; " +
			"events are refused until the first attestation adopts one")
	}
	return nil
}

// trustAnchors is the effective set of household roots this carrier will accept a
// chain to: the configured roots, plus any root adopted at founding.
func trustAnchors() [][]byte {
	if len(adoptedRoot) == ed25519.PublicKeySize {
		return append(append([][]byte(nil), configuredRoots...), adoptedRoot)
	}
	return configuredRoots
}

// MaybeAdoptRoot binds this carrier to a household the first time it stores that
// household's attestation, closing the founding window. It is a no-op once a root
// is known or when roots were pinned in config. Called after PutIdentityObject
// has already verified the attestation's self-signature, so `origin` is a proven
// household root — not an unauthenticated claim.
func MaybeAdoptRoot(origin []byte) error {
	if !allowAdoption || len(adoptedRoot) == ed25519.PublicKeySize || len(origin) != ed25519.PublicKeySize {
		return nil
	}
	adoptedRoot = append([]byte(nil), origin...)
	if err := st.PutMeta(metaHouseholdRoot, hex.EncodeToString(origin)); err != nil {
		adoptedRoot = nil // don't enforce against a root we failed to persist
		return err
	}
	log.Printf("chain gate: adopted household root %x at founding — now ENFORCING", origin)
	return nil
}

// Store exposes the live store for read-only controller use.
func Store() store.Store { return st }

// Blobs exposes the data-plane backend (the blob gateway serves it).
func Blobs() blobs.Backend { return blobStore }

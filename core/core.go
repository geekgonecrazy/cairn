// Package core wires Cairn together and holds the process's live state, in the
// rfd-tool/flockledger style: core.Setup() initializes unexported package-level
// singletons (the store, the realtime hub); everything else calls exported
// functions here rather than passing handles around.
package core

import (
	"crypto/ed25519"
	"fmt"
	"log"

	"github.com/geekgonecrazy/cairn/blobs"
	"github.com/geekgonecrazy/cairn/blobs/local"
	"github.com/geekgonecrazy/cairn/config"
	"github.com/geekgonecrazy/cairn/relay"
	"github.com/geekgonecrazy/cairn/store"
	"github.com/geekgonecrazy/cairn/store/sqlite"
)

var (
	st        store.Store
	blobStore blobs.Backend
	hub       *Hub

	// The relay's own identity: persisted, and what clients pin. Invite tokens
	// are signed under relayPriv. See package relay.
	relayPub  ed25519.PublicKey
	relayPriv ed25519.PrivateKey
)

// Setup selects and opens the store, creates the schema, and builds the realtime
// hub. Call after config.Load and before router.Start.
//
// v2 trust model: the relay is OPEN — it accepts any well-formed signed event
// whose sender resolves to a valid (non-revoked) member chain. There is no
// household root and no admission gate here yet; a relay allow-list + invite key
// is the next slice (docs/decisions.md §Trust model v2).
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
	// iroh-store — see docs/decisions.md §Deviations. Swapping in blobs/iroh here
	// is the only change needed above the Backend interface.
	bs, err := local.New(config.Config.BlobDir)
	if err != nil {
		return err
	}
	blobStore = bs

	hub = newHub()
	// The HTTP/SSE realtime stream is transport #1 behind the transport seam;
	// alternate transports (LAN, BLE, Meshtastic, relay-to-relay) register the
	// same way. See package transport.
	RegisterTransport(newSSETransport())

	// The relay's own keypair (persisted; clients pin the pubkey). Invites are
	// signed under it.
	pub, priv, err := relay.LoadOrCreateKey(st)
	if err != nil {
		return err
	}
	relayPub, relayPriv = pub, priv
	if config.Config.RequireInvite {
		log.Printf("relay %x — invite-only (allow-list enforced)", relayPub)
	} else {
		log.Printf("relay %x — OPEN (any valid sender admitted, recorded trust-on-first-use)", relayPub)
	}
	return nil
}

// Store exposes the live store for read-only controller use.
func Store() store.Store { return st }

// Blobs exposes the data-plane backend (the blob gateway serves it).
func Blobs() blobs.Backend { return blobStore }

// RelayPub is this relay's public key — what a client pins to know it is talking
// to the right relay, and what invite tokens verify against.
func RelayPub() []byte { return relayPub }

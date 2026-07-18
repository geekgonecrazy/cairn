// Package core wires Cairn together and holds the process's live state, in the
// rfd-tool/flockledger style: core.Setup() initializes unexported package-level
// singletons (the store, the realtime hub, the trusted-root set); everything
// else calls exported functions here rather than passing handles around.
package core

import (
	"encoding/hex"
	"fmt"

	"github.com/geekgonecrazy/cairn/config"
	"github.com/geekgonecrazy/cairn/store"
	"github.com/geekgonecrazy/cairn/store/sqlite"
)

var (
	st           store.Store
	hub          *Hub
	trustedRoots [][]byte
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

	hub = newHub()

	trustedRoots = nil
	for _, h := range config.Config.TrustedRoots {
		b, err := hex.DecodeString(h)
		if err != nil {
			return fmt.Errorf("core: bad trustedRoots hex %q: %w", h, err)
		}
		trustedRoots = append(trustedRoots, b)
	}
	return nil
}

// Store exposes the live store for read-only controller use.
func Store() store.Store { return st }

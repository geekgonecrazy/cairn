// Package config loads Cairn's runtime configuration. Convention matches the
// reference repos: config.Load(path) parses a YAML file into the package-level
// config.Config; a Store field selects the backend (default sqlite). Missing
// file → defaults (dev-friendly).
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Configuration is the whole of cairnd's config surface.
type Configuration struct {
	// Address is the HTTP listen address (Connect API + SSE + static webapp).
	Address string `yaml:"address" json:"address"`
	// Store selects the persistence backend. "" or "sqlite" → store/sqlite.
	Store string `yaml:"store" json:"store"`
	// SqlitePath is the sqlite DB file path (dev: wipe to reset).
	SqlitePath string `yaml:"sqlitePath" json:"sqlitePath"`
	// WebappDir, if set, is served as the SPA at / (built webapp/dist).
	WebappDir string `yaml:"webappDir" json:"webappDir"`
	// TrustedRoots are hex-encoded household root pubkeys this node recognizes.
	// Empty during early dev = accept any well-formed signed event (no chain
	// gate); once set, senders must chain to one of these roots.
	TrustedRoots []string `yaml:"trustedRoots" json:"trustedRoots"`
}

// Config is the loaded configuration (rfd-tool/flockledger package-var style).
var Config Configuration

func defaults() Configuration {
	return Configuration{
		Address:    ":8099",
		Store:      "sqlite",
		SqlitePath: "cairn.db",
		WebappDir:  "webapp/dist",
	}
}

// Load reads path into Config, applying defaults for any unset field. A missing
// file is not an error — Config becomes the defaults.
func Load(path string) error {
	Config = defaults()

	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("config: read %s: %w", path, err)
	}
	if err := yaml.Unmarshal(b, &Config); err != nil {
		return fmt.Errorf("config: parse %s: %w", path, err)
	}
	// Re-apply defaults for fields the file left blank.
	d := defaults()
	if Config.Address == "" {
		Config.Address = d.Address
	}
	if Config.Store == "" {
		Config.Store = d.Store
	}
	if Config.SqlitePath == "" {
		Config.SqlitePath = d.SqlitePath
	}
	return nil
}

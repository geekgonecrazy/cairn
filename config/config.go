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
	// BlobDir is the local blob backend's directory (the dev stand-in for
	// iroh-store — see docs/decisions.md §Deviations).
	BlobDir string `yaml:"blobDir" json:"blobDir"`
	// RequireInvite gates the write path on the relay allow-list (slice 2). When
	// false (default, dev), the relay is OPEN: it admits any valid sender and
	// records them trust-on-first-use, so the operator can see who's been carried
	// and switch to invite-only later. When true, a member must be on the
	// allow-list (added by an invite the operator issued, or `cairnctl allow`).
	RequireInvite bool `yaml:"requireInvite" json:"requireInvite"`
	// TLSCertFile/TLSKeyFile, if both set, make cairnd serve HTTPS instead of
	// cleartext.
	//
	// Not a deployment nicety — the webapp does not FUNCTION without it. Browsers
	// expose crypto.subtle only in a secure context (HTTPS, or localhost), and
	// every key operation in the client goes through it. Reached over a LAN IP on
	// plain HTTP, the app fails deep inside HPKE with "undefined is not an object
	// (evaluating 'this._api.importKey')", because crypto.subtle is undefined.
	//
	// A self-signed cert is enough: clicking through the browser warning still
	// yields a secure context.
	TLSCertFile string `yaml:"tlsCertFile" json:"tlsCertFile"`
	TLSKeyFile  string `yaml:"tlsKeyFile" json:"tlsKeyFile"`
}

// Config is the loaded configuration (rfd-tool/flockledger package-var style).
var Config Configuration

func defaults() Configuration {
	return Configuration{
		Address:    ":8099",
		Store:      "sqlite",
		SqlitePath: "cairn.db",
		WebappDir:  "webapp/dist",
		BlobDir:    "cairn-blobs",
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
	if Config.BlobDir == "" {
		Config.BlobDir = d.BlobDir
	}
	return nil
}

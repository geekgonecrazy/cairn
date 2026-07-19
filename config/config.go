// Package config loads Cairn's runtime configuration. Convention matches the
// reference repos: config.Load(path) parses a YAML file into the package-level
// config.Config; a Store field selects the backend (default sqlite). Missing
// file → defaults (dev-friendly).
package config

import (
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

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
	// iroh-store — see decisions.md §Deviations).
	BlobDir string `yaml:"blobDir" json:"blobDir"`
	// TrustedRoots are hex-encoded household root pubkeys this node recognizes.
	// Empty during early dev = accept any well-formed signed event (no chain
	// gate); once set, senders must chain to one of these roots.
	TrustedRoots []string `yaml:"trustedRoots" json:"trustedRoots"`
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
//
// trusted-roots.txt is loaded either way. `cairnctl init` writes it and reports
// "trusted via: trusted-roots.txt", and a node founded that way usually has no
// config.yaml at all; returning early here left the carrier refusing every event
// against a root it had just written.
func Load(path string) error {
	Config = defaults()

	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return loadTrustedRootsFile(path)
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
	return loadTrustedRootsFile(path)
}

// loadTrustedRootsFile merges roots from `trusted-roots.txt` beside the config
// into TrustedRoots.
//
// It is a separate file because `cairnctl init` WRITES it: rewriting config.yaml
// would destroy the hand-written comments in it, and YAML round-tripping with
// comments is a trap. Keeping the machine-managed list apart also makes "what
// does this node trust" a small file you can read at a glance.
//
// Absent file = no roots from here, which is not an error: a node that has never
// been founded is a normal state (the chain gate then refuses events until it is).
func loadTrustedRootsFile(configPath string) error {
	path := filepath.Join(filepath.Dir(configPath), "trusted-roots.txt")
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("config: read %s: %w", path, err)
	}
	seen := map[string]bool{}
	for _, r := range Config.TrustedRoots {
		seen[strings.ToLower(strings.TrimSpace(r))] = true
	}
	for i, line := range strings.Split(string(b), "\n") {
		// Strip comments: the file carries a header explaining itself, and
		// `init -name` annotates each root with which household it is.
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		root := strings.ToLower(strings.TrimSpace(line))
		if root == "" {
			continue
		}
		if _, err := hex.DecodeString(root); err != nil || len(root) != 64 {
			return fmt.Errorf("config: %s line %d: not a 32-byte hex household root: %q",
				path, i+1, root)
		}
		if !seen[root] {
			seen[root] = true
			Config.TrustedRoots = append(Config.TrustedRoots, root)
		}
	}
	return nil
}

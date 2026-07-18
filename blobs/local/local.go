// Package local is a filesystem blobs.Backend for development.
//
// ⚠️ This is the DEVIATION stand-in for iroh-store (see decisions.md §Deviations
// and the blobs package doc). It is deliberately dumb: content-addressed files in
// a directory, no peer-to-peer, no verified resumable streaming, pinning is a
// no-op because nothing is ever garbage-collected. `blobs/iroh` replaces it
// behind the same interface without touching anything above.
package local

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"lukechampine.com/blake3"

	"github.com/geekgonecrazy/cairn/blobs"
)

// Store keeps objects as files named by their hex content address.
type Store struct {
	dir string
}

var _ blobs.Backend = (*Store)(nil)

// New creates (if needed) and opens a blob directory.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("blobs/local: mkdir %s: %w", dir, err)
	}
	return &Store{dir: dir}, nil
}

func (s *Store) path(hash [32]byte) string {
	return filepath.Join(s.dir, hex.EncodeToString(hash[:]))
}

// Put content-addresses data and writes it if absent (idempotent by construction).
func (s *Store) Put(_ context.Context, data []byte) ([32]byte, error) {
	hash := blake3.Sum256(data)
	p := s.path(hash)
	if _, err := os.Stat(p); err == nil {
		return hash, nil // already have it
	}
	// Write via a temp file so a reader never sees a partial object.
	tmp, err := os.CreateTemp(s.dir, ".tmp-*")
	if err != nil {
		return hash, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return hash, err
	}
	if err := tmp.Close(); err != nil {
		return hash, err
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return hash, err
	}
	return hash, nil
}

func (s *Store) Get(_ context.Context, hash [32]byte) ([]byte, error) {
	b, err := os.ReadFile(s.path(hash))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, blobs.ErrNotFound
	}
	return b, err
}

// GetRange supports thumbnail-first / resumable reads. Offsets are clamped.
func (s *Store) GetRange(_ context.Context, hash [32]byte, off, length int64) ([]byte, error) {
	f, err := os.Open(s.path(hash))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, blobs.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if off < 0 {
		off = 0
	}
	if off >= fi.Size() {
		return []byte{}, nil
	}
	if length <= 0 || off+length > fi.Size() {
		length = fi.Size() - off
	}
	buf := make([]byte, length)
	if _, err := f.ReadAt(buf, off); err != nil {
		return nil, err
	}
	return buf, nil
}

func (s *Store) Has(_ context.Context, hash [32]byte) (bool, error) {
	_, err := os.Stat(s.path(hash))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// Pin is a no-op: this backend never collects garbage. Real pinning arrives with
// the iroh backend.
func (s *Store) Pin(_ context.Context, _ [32]byte) error { return nil }

// Package blobs is the data plane: file bytes live here, not in the room DAG.
// Chat carries only a tiny `file_ref` envelope; the bytes ride separately and may
// arrive over any transport (or not yet at all — see RetrievalState).
//
// ⚠️ DEVIATION FROM docs/plan.md — READ THIS (also recorded in docs/adrs/0011-blobs-backend-interface.md):
// docs/plan.md specifies `blobs` as an **iroh-store gRPC client**. No iroh-store daemon
// exists in this environment, so instead this package defines a pluggable Backend
// interface with a local filesystem implementation (blobs/local) for development.
// `blobs/iroh` implementing the same Backend drops in later and nothing above the
// interface changes. What is preserved: content addressing by BLAKE3 over the
// ENCRYPTED bytes (a backend never sees plaintext), the file_ref envelope, per-file
// key wrapping, range reads, and honest retrieval states. What is deferred: the
// real iroh data plane — peer-to-peer fetch, verified resumable multi-provider
// streaming, real pinning semantics.
//
// Mesh never carries file bytes regardless of backend — envelope only.
package blobs

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"

	"lukechampine.com/blake3"

	"github.com/fxamacker/cbor/v2"
	"github.com/geekgonecrazy/cairn/identity"
)

// Backend stores opaque, content-addressed bytes. Implementations: local
// (filesystem, dev) and — later — iroh. The address is always BLAKE3-256 of the
// bytes handed to Put, which are already encrypted, so a backend is zero-knowledge.
type Backend interface {
	// Put stores data and returns its BLAKE3-256 content address.
	Put(ctx context.Context, data []byte) ([32]byte, error)
	// Get returns the full object, or ErrNotFound.
	Get(ctx context.Context, hash [32]byte) ([]byte, error)
	// GetRange returns a byte range — the basis for thumbnail-first and resumable
	// reads. off/length are clamped to the object.
	GetRange(ctx context.Context, hash [32]byte, off, length int64) ([]byte, error)
	// Has reports local availability without fetching.
	Has(ctx context.Context, hash [32]byte) (bool, error)
	// Pin marks an object to be retained.
	Pin(ctx context.Context, hash [32]byte) error
}

var (
	ErrNotFound     = errors.New("blobs: object not found")
	ErrHashMismatch = errors.New("blobs: content does not match its hash")
	ErrKeySize      = errors.New("blobs: room key must be 32 bytes")
)

// KeySize is the per-file AES-256 key length.
const KeySize = 32

// FileRef is the envelope that rides on chat (docs/protocol.md §3 file_ref). It is
// small enough for a ~200 B LoRa frame; the bytes it points at are not.
type FileRef struct {
	Hash       []byte `cbor:"hash"`        // BLAKE3-256 of the ENCRYPTED bytes
	WrappedKey []byte `cbor:"wrapped_key"` // per-file key, sealed to the room key
	Mime       string `cbor:"mime"`
	Size       int64  `cbor:"size"` // plaintext size
	Name       string `cbor:"name,omitempty"`
	ThumbHash  []byte `cbor:"thumb_hash,omitempty"`
}

// RetrievalState is what the UI must say honestly about a file (docs/plan.md §4):
// never a fake "available", never an endless spinner.
type RetrievalState string

const (
	// StateAvailable — bytes are here and verified.
	StateAvailable RetrievalState = "available"
	// StatePending — we have the envelope but no fat link to fetch bytes over.
	// This is a real, terminal-until-connectivity state, not a loading spinner.
	StatePending RetrievalState = "pending"
	// StateDownloading — actively fetching (range reads may be partial).
	StateDownloading RetrievalState = "downloading"
	// StateBroken — fetched but failed verification or decryption.
	StateBroken RetrievalState = "broken"
)

// Seal encrypts plaintext under a fresh per-file key, stores the ciphertext in
// the backend (content-addressed by BLAKE3 over the ciphertext), pins it, and
// returns the envelope with the file key wrapped to the room key.
//
// The backend only ever sees ciphertext, so an untrusted or shared store learns
// nothing but size.
func Seal(ctx context.Context, b Backend, roomKey, plaintext []byte, mime, name string) (*FileRef, error) {
	if len(roomKey) != KeySize {
		return nil, ErrKeySize
	}
	fileKey := make([]byte, KeySize)
	if _, err := rand.Read(fileKey); err != nil {
		return nil, fmt.Errorf("blobs: gen file key: %w", err)
	}

	ciphertext, err := sealAESGCM(fileKey, plaintext)
	if err != nil {
		return nil, err
	}
	hash, err := b.Put(ctx, ciphertext)
	if err != nil {
		return nil, err
	}
	if err := b.Pin(ctx, hash); err != nil {
		return nil, err
	}

	wrapped, err := sealAESGCM(roomKey, fileKey)
	if err != nil {
		return nil, err
	}
	return &FileRef{
		Hash:       hash[:],
		WrappedKey: wrapped,
		Mime:       mime,
		Size:       int64(len(plaintext)),
		Name:       name,
	}, nil
}

// Open fetches the bytes named by ref, verifies the content address, unwraps the
// per-file key with the room key, and decrypts. Returns ErrNotFound when the
// bytes are simply not reachable — the caller renders StatePending, not an error.
func Open(ctx context.Context, b Backend, roomKey []byte, ref *FileRef) ([]byte, error) {
	if len(roomKey) != KeySize {
		return nil, ErrKeySize
	}
	var hash [32]byte
	copy(hash[:], ref.Hash)

	ciphertext, err := b.Get(ctx, hash)
	if err != nil {
		return nil, err
	}
	// Verify the content address before trusting the bytes.
	if blake3.Sum256(ciphertext) != hash {
		return nil, ErrHashMismatch
	}
	fileKey, err := openAESGCM(roomKey, ref.WrappedKey)
	if err != nil {
		return nil, fmt.Errorf("blobs: unwrap file key: %w", err)
	}
	return openAESGCM(fileKey, ciphertext)
}

// State reports the honest retrieval state for a ref without downloading it.
func State(ctx context.Context, b Backend, ref *FileRef) RetrievalState {
	var hash [32]byte
	copy(hash[:], ref.Hash)
	ok, err := b.Has(ctx, hash)
	if err != nil || !ok {
		return StatePending // no fat link / not here — say so
	}
	return StateAvailable
}

// EncodeRef / DecodeRef are the envelope's CBOR form (the file_ref payload).
func EncodeRef(r *FileRef) ([]byte, error) { return identity.Marshal(r) }

func DecodeRef(b []byte) (*FileRef, error) {
	var r FileRef
	if err := cbor.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// sealAESGCM = nonce(12) || AES-256-GCM(key, nonce, plaintext).
func sealAESGCM(key, plaintext []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

func openAESGCM(key, framed []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(framed) < gcm.NonceSize() {
		return nil, errors.New("blobs: ciphertext too short")
	}
	nonce, ct := framed[:gcm.NonceSize()], framed[gcm.NonceSize():]
	return gcm.Open(nil, nonce, ct, nil)
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("blobs: aes: %w", err)
	}
	return cipher.NewGCM(block)
}

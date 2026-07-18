package blobs_test

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"lukechampine.com/blake3"

	"github.com/geekgonecrazy/cairn/blobs"
	"github.com/geekgonecrazy/cairn/blobs/local"
)

func newStore(t *testing.T) blobs.Backend {
	t.Helper()
	s, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func roomKey() []byte { return bytes.Repeat([]byte{7}, 32) }

func TestSealOpen_RoundTrip(t *testing.T) {
	ctx := context.Background()
	b := newStore(t)
	plaintext := []byte("the quick brown fox jumps over the lazy dog")

	ref, err := blobs.Seal(ctx, b, roomKey(), plaintext, "text/plain", "fox.txt")
	if err != nil {
		t.Fatal(err)
	}
	if ref.Size != int64(len(plaintext)) || ref.Mime != "text/plain" || ref.Name != "fox.txt" {
		t.Fatalf("envelope mismatch: %+v", ref)
	}

	got, err := blobs.Open(ctx, b, roomKey(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatal("decrypted bytes differ from original")
	}
}

// The backend must never see plaintext: it stores ciphertext, addressed by the
// hash OF THE CIPHERTEXT.
func TestBackendStoresOnlyCiphertext(t *testing.T) {
	ctx := context.Background()
	b := newStore(t)
	secret := []byte("PLAINTEXT-CANARY-do-not-store-me")

	ref, err := blobs.Seal(ctx, b, roomKey(), secret, "text/plain", "s.txt")
	if err != nil {
		t.Fatal(err)
	}
	var h [32]byte
	copy(h[:], ref.Hash)
	stored, err := b.Get(ctx, h)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, secret) {
		t.Fatal("plaintext leaked into the blob store")
	}
	// And the address really is BLAKE3 over what was stored.
	if blake3.Sum256(stored) != h {
		t.Fatal("stored bytes are not addressed by their own BLAKE3")
	}
}

func TestOpen_WrongRoomKeyFails(t *testing.T) {
	ctx := context.Background()
	b := newStore(t)
	ref, _ := blobs.Seal(ctx, b, roomKey(), []byte("secret"), "text/plain", "")
	other := bytes.Repeat([]byte{9}, 32)
	if _, err := blobs.Open(ctx, b, other, ref); err == nil {
		t.Fatal("opening with the wrong room key must fail")
	}
}

func TestOpen_MissingBytesIsNotFound(t *testing.T) {
	// The envelope arrived but the bytes did not — this is StatePending in the
	// UI ("pending — no fat link"), not an error to the user.
	ctx := context.Background()
	sender := newStore(t)
	receiver := newStore(t) // a peer that never got the bytes

	ref, _ := blobs.Seal(ctx, sender, roomKey(), []byte("payload"), "text/plain", "")
	if st := blobs.State(ctx, receiver, ref); st != blobs.StatePending {
		t.Fatalf("state = %q, want pending", st)
	}
	if _, err := blobs.Open(ctx, receiver, roomKey(), ref); !errors.Is(err, blobs.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if st := blobs.State(ctx, sender, ref); st != blobs.StateAvailable {
		t.Fatalf("sender state = %q, want available", st)
	}
}

func TestOpen_CorruptedBytesDetected(t *testing.T) {
	ctx := context.Background()
	b := newStore(t)
	ref, _ := blobs.Seal(ctx, b, roomKey(), []byte("important"), "text/plain", "")

	// Simulate a store that returns the wrong bytes for a hash.
	if _, err := blobs.Open(ctx, corrupting{b}, roomKey(), ref); !errors.Is(err, blobs.ErrHashMismatch) {
		t.Fatalf("content-address verification must catch corruption, got %v", err)
	}
}

type corrupting struct{ blobs.Backend }

func (c corrupting) Get(ctx context.Context, h [32]byte) ([]byte, error) {
	b, err := c.Backend.Get(ctx, h)
	if err != nil {
		return nil, err
	}
	out := append([]byte(nil), b...)
	out[len(out)-1] ^= 0xff
	return out, nil
}

func TestGetRange(t *testing.T) {
	ctx := context.Background()
	b := newStore(t)
	data := []byte("0123456789abcdef")
	h, err := b.Put(ctx, data)
	if err != nil {
		t.Fatal(err)
	}
	part, err := b.GetRange(ctx, h, 4, 6)
	if err != nil {
		t.Fatal(err)
	}
	if string(part) != "456789" {
		t.Fatalf("range = %q, want 456789", part)
	}
	// Clamped: length beyond EOF returns the tail.
	tail, _ := b.GetRange(ctx, h, 10, 999)
	if string(tail) != "abcdef" {
		t.Fatalf("clamped range = %q", tail)
	}
}

func TestPut_Idempotent(t *testing.T) {
	ctx := context.Background()
	b := newStore(t)
	h1, _ := b.Put(ctx, []byte("same"))
	h2, _ := b.Put(ctx, []byte("same"))
	if h1 != h2 {
		t.Fatal("content addressing must be stable")
	}
}

func TestRefEncodeDecode(t *testing.T) {
	ref := &blobs.FileRef{Hash: []byte{1, 2}, WrappedKey: []byte{3}, Mime: "image/png", Size: 42, Name: "a.png"}
	enc, err := blobs.EncodeRef(ref)
	if err != nil {
		t.Fatal(err)
	}
	got, err := blobs.DecodeRef(enc)
	if err != nil {
		t.Fatal(err)
	}
	if got.Mime != "image/png" || got.Size != 42 || got.Name != "a.png" {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

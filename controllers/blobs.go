package controllers

import (
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/geekgonecrazy/cairn/blobs"
	"github.com/geekgonecrazy/cairn/core"
)

// The blob gateway. Bytes arrive already encrypted under a per-file key, so this
// endpoint is zero-knowledge — it stores and returns opaque, content-addressed
// blobs and never sees plaintext or any key.
//
// NOTE: backed by the local filesystem backend standing in for iroh-store (see
// docs/decisions.md §Deviations). With the iroh backend this gateway becomes a
// fallback path rather than the primary one, since peers fetch directly.

const maxBlobBytes = 64 << 20 // 64 MiB

// PutBlobHandler stores encrypted bytes and returns their BLAKE3 content address.
// POST /v1/blob  →  {"hash":"<hex>"}
func PutBlobHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBlobBytes))
	if err != nil {
		http.Error(w, "blob too large or unreadable", http.StatusRequestEntityTooLarge)
		return
	}
	hash, err := core.Blobs().Put(r.Context(), data)
	if err != nil {
		http.Error(w, "store failed", http.StatusInternalServerError)
		return
	}
	if err := core.Blobs().Pin(r.Context(), hash); err != nil {
		http.Error(w, "pin failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"hash":"` + hex.EncodeToString(hash[:]) + `"}`))
}

// GetBlobHandler returns encrypted bytes by content address, supporting a single
// Range request so clients can do thumbnail-first / resumable reads.
// GET /v1/blob/<hex hash>
func GetBlobHandler(w http.ResponseWriter, r *http.Request) {
	hexHash := strings.TrimPrefix(r.URL.Path, "/v1/blob/")
	raw, err := hex.DecodeString(hexHash)
	if err != nil || len(raw) != 32 {
		http.Error(w, "bad hash", http.StatusBadRequest)
		return
	}
	var hash [32]byte
	copy(hash[:], raw)

	// A missing blob is an honest 404 — the client renders "pending — no fat
	// link", not an error.
	if ok, err := core.Blobs().Has(r.Context(), hash); err != nil || !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable") // content-addressed

	if rng := r.Header.Get("Range"); rng != "" {
		if off, length, ok := parseRange(rng); ok {
			part, err := core.Blobs().GetRange(r.Context(), hash, off, length)
			if err != nil {
				http.Error(w, "range failed", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Length", strconv.Itoa(len(part)))
			w.WriteHeader(http.StatusPartialContent)
			w.Write(part)
			return
		}
	}

	data, err := core.Blobs().Get(r.Context(), hash)
	if errors.Is(err, blobs.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Write(data)
}

// parseRange handles the single "bytes=start-[end]" form we need.
func parseRange(h string) (off, length int64, ok bool) {
	if !strings.HasPrefix(h, "bytes=") {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(h, "bytes=")
	if strings.Contains(spec, ",") {
		return 0, 0, false // multi-range unsupported
	}
	start, end, found := strings.Cut(spec, "-")
	if !found {
		return 0, 0, false
	}
	o, err := strconv.ParseInt(start, 10, 64)
	if err != nil {
		return 0, 0, false
	}
	if end == "" {
		return o, 0, true // to EOF
	}
	e, err := strconv.ParseInt(end, 10, 64)
	if err != nil || e < o {
		return 0, 0, false
	}
	return o, e - o + 1, true
}

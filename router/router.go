// Package router builds the HTTP surface and serves it: the ConnectRPC handler,
// the SSE realtime endpoint, and the static SPA. Tiny by design — cmd/cairnd
// calls config.Load → core.Setup → router.Start and nothing else.
package router

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"github.com/geekgonecrazy/cairn/config"
	"github.com/geekgonecrazy/cairn/controllers"
	"github.com/geekgonecrazy/cairn/proto/cairnv1/cairnv1connect"
)

// Start builds the mux and blocks serving it. h2c lets native gRPC clients speak
// HTTP/2 over cleartext for local dev; browsers use HTTP/1.1.
func Start() error {
	mux := http.NewServeMux()

	// ConnectRPC: unary CairnService (SendEvent/Sync/History/GetIdentityObject).
	path, handler := cairnv1connect.NewCairnServiceHandler(controllers.CairnController{})
	mux.Handle(path, handler)

	// Realtime SSE (decided transport).
	mux.HandleFunc("/v1/subscribe", controllers.SubscribeSSE)

	// Blob gateway (data plane). Stores opaque encrypted bytes by content
	// address; never sees plaintext. Local backend standing in for iroh-store.
	mux.HandleFunc("/v1/blob", controllers.PutBlobHandler)
	mux.HandleFunc("/v1/blob/", controllers.GetBlobHandler)

	// Static SPA (built webapp), if present. The app is built with base /__hub/
	// (so the same bundle is hostable by the Wails3 native app, which claims
	// /wails/). Serve it under /__hub/ and bounce / there. Unknown /__hub/* paths
	// fall back to index.html for client-side routing.
	if dir := config.Config.WebappDir; dir != "" {
		if _, err := os.Stat(dir); err == nil {
			mux.Handle("/__hub/", http.StripPrefix("/__hub/", spaHandler(dir)))
			mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/" {
					http.Redirect(w, r, "/__hub/", http.StatusFound)
					return
				}
				http.NotFound(w, r)
			})
		} else {
			log.Printf("router: webappDir %q not found; serving API only", dir)
		}
	}

	// With TLS, HTTP/2 is negotiated by ALPN, so the h2c wrapper is neither
	// needed nor wanted — h2c is the cleartext fallback for native gRPC clients.
	cert, key := config.Config.TLSCertFile, config.Config.TLSKeyFile
	if cert != "" && key != "" {
		srv := &http.Server{Addr: config.Config.Address, Handler: withCORS(mux)}
		log.Printf("cairnd listening on %s (TLS)", config.Config.Address)
		return srv.ListenAndServeTLS(cert, key)
	}
	if cert != "" || key != "" {
		log.Printf("router: tlsCertFile and tlsKeyFile must BOTH be set; serving cleartext")
	}

	srv := &http.Server{
		Addr:    config.Config.Address,
		Handler: h2c.NewHandler(withCORS(mux), &http2.Server{}),
	}
	log.Printf("cairnd listening on %s", config.Config.Address)
	return srv.ListenAndServe()
}

// spaHandler serves files from dir (paths already have the /__hub/ prefix
// stripped), falling back to index.html for any path that isn't an existing
// file so client-side routing works.
//
// CACHING IS THE WHOLE TRICK HERE, and getting it wrong is not a performance
// issue — it is a correctness one. Vite content-hashes every asset
// (index-B7XzFQ3.js), so those are safe to cache forever. index.html is what
// NAMES those hashes, so if it is cached the browser keeps loading yesterday's
// bundle and no amount of reloading helps. On a phone, where "hard reload" is
// not really available, that means a deployed fix simply never arrives.
//
// So: index.html must always be revalidated, hashed assets are immutable.
func spaHandler(dir string) http.Handler {
	index := filepath.Join(dir, "index.html")

	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		// no-cache means "revalidate before using", not "never store" — the
		// browser may still keep it and a 304 stays cheap. no-store would work
		// too but re-downloads a small file every time for no benefit.
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		http.ServeFile(w, r, index)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/")
		if rel == "" {
			serveIndex(w, r)
			return
		}
		clean := filepath.Clean(rel)
		if strings.HasPrefix(clean, "..") {
			http.NotFound(w, r)
			return
		}
		if fi, err := os.Stat(filepath.Join(dir, clean)); err == nil && !fi.IsDir() {
			// Anything under assets/ carries a content hash in its name, so a
			// changed file is a changed URL and this can never serve staleness.
			// Everything else (favicon.svg, icons.svg) has a stable name and must
			// be revalidated, or an updated icon would stick around indefinitely.
			if strings.HasPrefix(clean, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache, must-revalidate")
			}
			http.ServeFile(w, r, filepath.Join(dir, clean))
			return
		}
		serveIndex(w, r) // SPA fallback
	})
}

// withCORS is a permissive dev CORS wrapper so a Vite dev server (a different
// origin) can call the Connect API and open the SSE stream. Reflects the request
// origin and allows the headers connect-es sends.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Vary", "Origin")
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Allow-Headers", strings.Join([]string{
				"Content-Type", "Connect-Protocol-Version", "Connect-Timeout-Ms",
				"Grpc-Timeout", "X-Grpc-Web", "X-User-Agent", "Authorization", "Range",
			}, ", "))
			h.Set("Access-Control-Expose-Headers", strings.Join([]string{
				"Grpc-Status", "Grpc-Message", "Grpc-Status-Details-Bin",
			}, ", "))
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

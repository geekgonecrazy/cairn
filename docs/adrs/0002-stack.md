# 2. Go backend, Svelte PWA, pure-Go SQLite, ConnectRPC + SSE

- Status: Accepted
- Date: 2026-07-18

## Context

Cairn needs a frontend, a backend, storage, and an RPC layer that compose into one
local-first system — one that must also cross-compile cleanly to mobile and native
targets later, and share a single wire contract between Go and the browser.

## Decision

- **Frontend:** Svelte + Vite, built as a PWA (SPA mode), served both as a browser app
  and, later, inside a native wrapper.
- **Backend:** a single Go binary, `cairnd`.
- **Storage:** SQLite via `modernc.org/sqlite` — pure Go, **no cgo** — everywhere a Go
  runtime needs a database. The browser uses OPFS/IndexedDB (no SQLite in-browser).
- **RPC:** ConnectRPC — one `proto/cairn.proto` generates the Go server stubs and the
  TypeScript client, so there is one typed contract and no separate gateway.
- **Realtime:** a plain HTTP **SSE** stream (`GET /v1/subscribe`), not a WebSocket or
  gRPC server-stream.

## Consequences

- Pure-Go SQLite cross-compiles without a C toolchain — the property that makes the
  planned mobile/native on-device node a build target rather than a rewrite.
- The single proto is the contract for both Go and the browser; the two never drift on
  the RPC surface.
- SSE is deliberately lossy: a dropped frame is recovered by the next frontier sync
  ([ADR-0003](0003-signed-event-dag.md)), so a simple stream is enough and a reconnect
  is never a lost message.
- Diverges from the reference repos' Gin REST; accepted to keep one proto contract.

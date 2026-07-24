# 5. Go and the browser are kept byte-identical by conformance vectors

- Status: Accepted
- Date: 2026-07-18

## Context

Go (the server, headless agents, and the future native node) and the browser each
implement the wire format independently. If their canonical encodings drift by a single
byte, an event signed on one side fails verification on the other — and it fails
silently, as unverifiable events in production rather than as an obvious error.

## Decision

Keep the two implementations (Go and TypeScript) and pin their agreement with **golden
conformance vectors** asserted on both sides: the canonical `event_id`, the
identity-object signing bytes and hashes, the HKDF key derivations, and the
pairing/invite wire formats. `npm run conformance` and `npm run identity-conformance`
assert the same constants a Go test asserts.

## Consequences

- Drift surfaces as a **failing test**, not a production incident.
- Any change to a canonical encoding must regenerate the vectors on both sides — the
  test is the tripwire that forces it.
- Maintaining two implementations is a real tax; it is accepted for now. The path out is
  compiling the Go core to WASM so the browser runs the same implementation (an open
  direction, not yet decided — see [`../architecture.md`](../architecture.md) §4).

## Known limit — whole-number floats

JS cannot distinguish `640.0` from `640`, so a whole number always encodes as a CBOR
integer in the browser, while Go's `float64(640)` emits a float. Values round-trip
correctly; only the byte form differs. This is safe because inlay *bindings* are never
hashed — `decl_cid` covers the DECLARATION, whose numbers are integers. Do not rely on
byte-identical encoding of whole-number floats across the two implementations. (The
encoders otherwise agree, asserted by golden vectors: `0.66 → fb3fe51eb851eb851f`,
`24.6 → fb403899999999999a`. The earlier browser encoder truncated every non-integer to
an int — silent corruption of inlay fractions — and threw on decoding Go-authored floats;
both are fixed.)

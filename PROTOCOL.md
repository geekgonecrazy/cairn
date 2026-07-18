# Cairn — protocol spec

The concrete contract behind [`proto/cairn.proto`](./proto/cairn.proto): identity & crypto, the
event envelope, payload schemas, the room DAG, sync, room keys, the API, and the SQLite schema. This
is what an implementer needs to reach the **Phase 1 exit** ("two clients converge a verified
history"). Grounded in `/root/code/vision/systems/cairn/protocol.md`; where that doc left a knob
open, it's flagged **[OPEN]** here.

> **Dev-phase policy:** until we declare *real users*, this schema is **freely breakable** — change
> the proto/CBOR/SQLite in place, no versioning, **wipe the DB at will, no migrations** (see
> `decisions.md`). Backward-compat starts only at the real-users switch.

Primitives (no inventing): **Ed25519** (signing), **BLAKE3-256** (content hash / `event_id`),
**AES-256-GCM** (room payload encryption), **X25519-HPKE** (wrapping room keys to members),
**deterministic CBOR** (RFC 8949 §4.2) for canonical content and payloads, **WebAuthn** (browser
device key). Two identity systems never mix: Capsule identity ≠ Cairn/household identity.

---

## 1. Identity & keys

Three tiers, one chain, no key ever copied — each identity generates its own keypair and holds only
its own private key; trust propagates as signed attestations.

```
household root        Ed25519, offline (steel). Signs identity attestations ONLY. `origin` = its pubkey.
   │ identity_attestation (signed by household root)
member root / service Ed25519. kind=human|agent (room members) | service (plumbing, not a member).
   │ device_delegation (signed by the member root)
device / instance key Ed25519 (browser: a WebAuthn passkey). One per device/instance.
   │ session_delegation (browser only; signed by the passkey)   [web two-tier signing]
session key           WebCrypto Ed25519, short-lived (~hours). Signs chat-rate events.
```

### Identity-log objects (CBOR, content-addressed, fetched by hash)

```
identity_attestation { pubkey, kind, origin, operated_by, display_name, issued_at, sig }
    # sig = Ed25519 by household root over deterministic-CBOR of the rest. kind & origin are IMMUTABLE.
device_delegation    { device_pub, member_pub, issued_at, expires_at?, sig }
    # sig = Ed25519 by member_pub.
session_delegation   { session_pub, device_pub, scope, expires_at, sig }   # browser only
    # sig = the passkey (WebAuthn). Verifiers accept the WebAuthn envelope (§2.3).
device_revoke        { device_pub, member_pub, revoked_at, sig }           # sig by member_pub
```

These live in the **household identity log** (their own append-only content-addressed set), *not* in
a room. A client fetches one by hash (`GetIdentityObject`) the first time it meets an unknown sender.

### Verifying a sender (one chain walk)

`sender_pub` (device or session) → its `device_delegation`/`session_delegation` → `member_root` →
`identity_attestation` signed by a **household root the verifier recognizes** (`origin`). Reject if the
chain doesn't terminate at a known root, if any sig fails, or if any link is expired/revoked. The
`kind`/`origin`/`operated_by` for UI (agent badge, cross-household marking) come from the attestation
— attested, not self-asserted.

---

## 2. The Event envelope

Wire fields in [`proto/cairn.proto`](./proto/cairn.proto). Semantics:

### 2.1 Canonical content, `event_id`, `sig`

```
content     = det-CBOR([ sender_pub, room_id, ts, sort(parents), int(type), payload ])
event_id    = BLAKE3-256(content)                       # 32 bytes
sig         = Ed25519(sender_priv, event_id)            # sign the digest
```

- `parents` are **sorted ascending** before hashing so the id is canonical.
- `event_id` and `sig` are **excluded** from `content` (they're derived from it).
- Verify: recompute `content` → `event_id`; check it equals the envelope's; check `sig` over it.
- For **passkey-signed** authority events, `sig` is the WebAuthn signature envelope (§2.3).

### 2.2 Payload — CBOR, encrypted under the room key

```
payload = uvarint(key_epoch) || nonce(12) || AES-256-GCM_seal(room_key[epoch], nonce, plaintext, aad)
plaintext = det-CBOR(<type payload map>)                # §3
aad       = sender_pub || room_id || ts(le64) || uint16(type)
```

- `key_epoch` selects which room-key epoch decrypts this (§5). `key_epoch = 0` ⇒ **not
  room-encrypted** — used by identity events and by `member_add`/`room_key_rotate`, whose payloads
  carry their own (per-recipient HPKE-wrapped) key material in cleartext-CBOR.
- No circularity: the ciphertext is fixed before `event_id` is computed; `aad` uses only pre-hash
  fields.

### 2.3 Passkey (WebAuthn) signatures

Capability-bound authority events (`approval_grant`, `member_add`, `room_key_rotate`, install grants)
signed on a browser carry a WebAuthn signature object (`authenticatorData || clientDataJSON` +
signature) where the challenge is the `event_id`. Verifiers must accept this envelope for these types.
**[OPEN]** exact on-chain shape — raw WebAuthn envelope vs. a gesture-gated session-key sig (see
`decisions.md`). Lock before Phase 5; Phase 1 uses plain Ed25519 device-key sigs.

---

## 3. Payload schemas (CBOR maps, per type)

Only the frequently-needed ones spelled out; all are small (chat/reaction/`task_update`/`approval_*`
fit a ~200 B LoRa frame). Fields are CBOR map keys.

**Chat group**
- `chat` `{ text, reply_to?: event_id, quote?: { text, author, source_event, source_room?, ts } }`
- `file_ref` `{ file: { hash, wrapped_key, mime, size, thumb_hash? }, caption?, reply_to? }`
  — bytes ride the data plane; envelope only (§ data-plane, `decisions.md` D2).
- `presence` `{ state: "online"|"away", via? }` (ephemeral; not folded into history views)
- `reaction` `{ target: event_id, emoji: [..] }` — sender's **complete current set**; latest per
  `(sender_root, target)` wins (CRDT).
- `edit` `{ target: event_id, text }` — **author-only** (sender resolves to the target's *member
  root*). Original `event_id` is permanent; edit history is free (append-only). *(Dev-phase: for chat
  the superseding content is just the new `text`; a general `payload` form can return later.)*
- `delete` `{ target: event_id, by: "author"|"admin" }` — author **or** room admin; renders as
  withdrawal. Not cryptographic erasure — say so in UI.

**Agent** — `task_request` `{ title, detail? }` · `task_update` `{ task_id, status, progress?, note? }`
· `notify` `{ text, level? }` (debounced) · `command` `{ action_ref, args? }`.

**Authority** (see §7) — `approval_request` `{ request_id, agent_pub, capability, request_hash,
expires_at }` · `approval_grant` `{ request_id, capability_hash, agent_pub, expires_at }` (passkey) ·
`approval_deny` `{ request_id, reason? }` · `credential_minted` `{ request_id }`.

**Inlay UI** — `inlay` `{ decl_cid, surface, bindings?, text }` (declared-inlay CID + mandatory `text`
fallback) · `inlay_update` `{ target: event_id, state }` (checkpoint) · `inlay_unpin` `{ target }` ·
`interaction` `{ target, action_ref, args?, capability? }` (capability-bound ⇒ broadcast, §8).

**Call** — `signaling_offer|answer|ice` `{ call_id, sdp|candidate }` · `call_ring` `{ call_id, kind:
"voice"|"video" }` · `call_bye` `{ call_id }`.

**Room state** — `member_add` `{ member_pub, role, wrapped_keys: {member_pub → hpke_blob}, epoch }` ·
`member_remove` `{ member_pub }` · `room_key_rotate` `{ epoch, wrapped_keys: {member_pub →
hpke_blob} }` · `space_create|space_update` `{ space_id, name, admit_kind: [human,agent?],
admit_origin: "own"|"any"|[root_pub..] }` (signed admin act).

---

## 4. The room DAG

A room is an append-only set of signed events with causal `parents`.

- **Heads** = events with no observed child, per room.
- **On create:** `parents` := current local heads for the room; after append, the new event is the
  sole head (until concurrency reintroduces siblings).
- **Merge = hash-set union** (`event_id` dedups). Commutative, associative, idempotent → same set ⇒
  same view on every node.
- **Order** = causal (ancestor happens-before). **Concurrent** events (neither an ancestor of the
  other) tiebreak by **lower `event_id`**. **[OPEN]** confirm the tiebreak composes with parent-count
  + `ts` without pathology.
- **Derived views fold deterministically** on top: a message's rendered state = its latest
  `edit`/`delete` by causal-order+tiebreak; a reaction summary = union of latest per-sender sets; an
  inlay = its latest checkpoint + descendant bound events. Threads are a **view** over `reply_to`, not
  a wire concept.
- Out-of-order delivery is the **normal case**. `reply_to` (semantic) is never conflated with
  `parents` (causal/sync).

This is *not* Matrix state resolution — borrow from Scuttlebutt / Hypercore / iroh-gossip / Automerge.

---

## 5. Room keys & rotation

- Each room has a symmetric **`room_key`** per **epoch** (AES-256). Payloads name their `key_epoch`.
- **Join / leave rotates.** `member_add` and `member_remove` produce a new epoch via
  `room_key_rotate`: generate a fresh `room_key`, **HPKE-wrap it to each current member's pubkey**,
  emit the wrapped set (cleartext-CBOR payload, `key_epoch = 0`). Each member unwraps with its own key.
- **Pre-join history is opaque** to new members (they only receive the current+future epoch keys) —
  state this rule in UI. Same practical property as Megolm; no forward secrecy past rotation.
- **[OPEN]** who is authorized to rotate (admin set), and the exact rekey-on-`member_remove` timing.

---

## 6. Sync (the frontier / outbox)

Frontier exchange, per room, per peer — the durable "what's undelivered" cursor from `decisions.md`
(a diff, not a queue):

1. Client sends `SyncRequest{ room_id, have_heads }`.
2. Peer computes the subgraph reachable from **its** heads but **not** from `have_heads` (walk parents
   until you reach the client's frontier) → returns it as `missing`, plus its own `heads`.
3. Client applies `missing` (dedup by `event_id`), recomputes heads; from the peer's `heads` it
   computes what the peer lacks and pushes those via `SendEvent`.
4. **Missing parent** ⇒ request it by hash and walk back; out-of-order is normal.
5. Persist per-peer heads in `peer_frontier` → "undelivered to peer X" = local events not behind X's
   frontier. Retry when a route returns; recipients dedup by `event_id`, so multi-path is harmless.

**[OPEN]** bound on incremental sync after a long partition (a device on mesh for a week).

---

## 7. Approvals (broker = pure verifier)

Wire flow (no bots, no JSON-in-body): agent emits `approval_request` (signed by its device key) →
approver's client renders the inlay → human approves; client emits `approval_grant` (passkey-signed,
request-bound + agent-bound + single-use) → agent presents the pair (its request + the grant) to the
broker → broker verifies both sigs + binding + policy + its consumed-id cache → mints the credential,
emits `credential_minted`, records the `request_id` as consumed. A compromised broker can deny but
cannot fabricate "the user said yes" (it must present the user's real signature).

---

## 8. API surface

`Event` is proto on the wire regardless of binding. Unary binding is **[OPEN]** (ConnectRPC vs Gin
REST over the proto types — `decisions.md`). Realtime is **SSE** (decided).

- **`SendEvent`** — submit a signed `Event`; server verifies, stores, fans out per routing (§9).
- **`Sync`** — frontier exchange (§6).
- **`History`** — backfill by walking parents.
- **`GetIdentityObject`** — fetch an identity-log object by hash.
- **Realtime `Subscribe` (SSE):** `GET /v1/subscribe` (auth'd) → an `text/event-stream` that pushes
  each new `Event` for the client's rooms as it lands (proto bytes base64 in the SSE `data:` field, or
  proto-JSON). Server-side lives in `controllers/sse.go` (flockledger pattern). The client re-syncs
  via `Sync` on (re)connect, so a missed SSE frame is never a lost message.

The server is **convenience, not authority** — events are signed and the DAG converges without it;
two LAN devices can talk directly. The server adds history continuity, the broker endpoint, and
file-pin coordination.

---

## 9. Transport routing (summary; full table in the vision)

Recipients are **pubkeys**, not addresses. Per-recipient priority over reachable transports: LAN gRPC
(or iroh-LAN via mDNS) → BLE → Meshtastic → iroh-WAN. Try-and-fall-through with a small time budget;
queue locally with TTL if nothing reaches a pubkey; dedup by `event_id`. Per-type defaults
(`chat`=cheapest; `approval_request`/`call_ring`/capability-bound `interaction`=**broadcast all**,
non-overridable). Preferences (most-specific wins): per-message `hint` → per-room ordering → user mode
(`auto|field|home|mesh-only|lan-only`). `arrived_via` on each inbound event feeds reachability. Wake
policy is a **separate** table (`cross-cutting/push-wake.md`).

---

## 10. SQLite schema (`store/sqlite`)

Pragmatic starting schema; one file per entity in `store/sqlite/`. **Dev phase: no migrations — a
single `CreateTables`/`CheckDb` that (re)creates the schema; wipe the DB file to reset.** Migrations
land only at the real-users switch.

```sql
-- events: the DAG (payload stored as received — encrypted)
CREATE TABLE events (
  event_id   BLOB PRIMARY KEY,
  room_id    BLOB NOT NULL,
  sender_pub BLOB NOT NULL,
  ts         INTEGER NOT NULL,
  type       INTEGER NOT NULL,
  payload    BLOB NOT NULL,
  sig        BLOB NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_events_room ON events(room_id, ts);

CREATE TABLE event_parents (            -- edges, for head computation & walks
  event_id  BLOB NOT NULL,
  parent_id BLOB NOT NULL,
  PRIMARY KEY (event_id, parent_id)
);
CREATE INDEX idx_parents_parent ON event_parents(parent_id);

CREATE TABLE room_heads (               -- current heads per room (maintained)
  room_id  BLOB NOT NULL,
  event_id BLOB NOT NULL,
  PRIMARY KEY (room_id, event_id)
);

CREATE TABLE rooms   ( room_id BLOB PRIMARY KEY, space_id BLOB, name TEXT, transport_pref TEXT, created_at INTEGER );
CREATE TABLE spaces  ( space_id BLOB PRIMARY KEY, name TEXT, admit_kind TEXT, admit_origin TEXT, policy BLOB );
CREATE TABLE members ( room_id BLOB, member_pub BLOB, role TEXT, added_event BLOB, PRIMARY KEY (room_id, member_pub) );

CREATE TABLE room_keys ( room_id BLOB, epoch INTEGER, key BLOB, PRIMARY KEY (room_id, epoch) ); -- local unwrapped key

-- identity log: one content-addressed table. obj_type+subject_pub index the
-- chain-walk resolver; hash serves GetIdentityObject. subject_pub = the pubkey
-- the object AUTHORIZES (session_pub / device_pub / member_pub / revoked device).
CREATE TABLE identity_log (
  hash        BLOB PRIMARY KEY,   -- BLAKE3-256 of the det-CBOR object
  obj_type    TEXT NOT NULL,      -- attestation|device_delegation|session_delegation|device_revoke
  subject_pub BLOB NOT NULL,
  cbor        BLOB NOT NULL
);
CREATE INDEX idx_identity_subject ON identity_log(obj_type, subject_pub);

CREATE TABLE peer_frontier ( peer_pub BLOB, room_id BLOB, head_id BLOB, PRIMARY KEY (peer_pub, room_id, head_id) ); -- outbox cursor

CREATE TABLE meta ( key TEXT PRIMARY KEY, value TEXT );
```

The browser client keeps the equivalent in OPFS/IndexedDB (no SQLite in-browser); the server and the
Wails3 on-device node use this schema via `store/sqlite`.

---

## 11. Open items to lock (tracked in `decisions.md` / vision)

- Household-root bootstrap & recovery (apex key, its own recovery code) — **Phase 4**.
- Tiebreak edge cases vs. parent-count + `ts` — **Phase 1**.
- Room-key rotation authority + `member_remove` timing — **Phase 1**.
- Incremental-sync bound after long partition — **Phase 3**.
- Passkey `approval_grant` envelope shape — **Phase 5**.
- Unary API binding (ConnectRPC vs Gin REST) — before wiring `controllers`.

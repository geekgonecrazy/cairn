# Cairn — milestones & exit criteria

Per-phase "done" definitions for the plan in [`plan.md`](./plan.md). A phase is not
finished until its exit criterion is demonstrable, not just coded. The **Phase 3
demonstration** is the vision's headline milestone and is defined up front (below), so
the bridge-tax payoff is measurable from day one.

---

## Phase 0 — Foundations

**Exit:** a signed `Event` round-trips proto ↔ Go ↔ TS; the delegation chain verifies;
the Svelte shell renders an empty room with the design system.

- [x] `proto/` full event enum + `CairnService` Connect defs; Go generated to `proto/cairnv1`.
- [x] `identity`: Ed25519 keygen + chain-walk verify (session→device→member→household root),
      with expiry/revoke/tamper/untrusted-root/missing-link tests.
- [x] `event`: canonical det-CBOR content, BLAKE3-256 `event_id`, Ed25519 sig, verify;
      DAG heads; proto round-trip. Parent-order-invariant id.
- [x] `store` + `store/sqlite` (modernc): schema/CheckDb, DAG head maintenance
      (fork/merge/out-of-order), frontier sync diff, identity-log resolver — all tested.
- [x] `cmd/cairnd`: ConnectRPC API + SSE realtime; signed Event sent, stored, re-synced,
      and broadcast end-to-end (see `cmd/smoke`).
- [x] `webapp`: Svelte+Vite PWA scaffold, SPA base `/__hub/`, design system ported
      (OKLCH tokens, Icon set, shell: space rail + room list + room view + composer),
      generated Connect-ES client + SSE, empty room renders; builds + typechecks clean;
      served by cairnd under `/__hub/`.

## Phase 1 — MVP: LAN chat + verified history

**Exit:** two browsers on one LAN converge a verified, signed history; a server restart
loses no history; message states reflect real delivery
(`sending → sent → queued (no route) → delivered (path unknown)`).

- [x] Per-room key + AES-256-GCM payloads (`room` pkg): framing `uvarint(epoch)||nonce||ct`,
      AAD-bound; payload CBOR schemas (chat/reaction/edit/delete/presence). Tested.
- [x] **Client-side crypto with proven Go↔TS interop**: minimal deterministic CBOR + BLAKE3
      + Ed25519 producing byte-identical `event_id`s; a TS-built encrypted event verifies
      *and* decrypts on the Go server (cross-language conformance demonstrated).
- [x] Local-first write + incremental sync (frontier diff) over the wire (Connect + SSE).
- [x] Composer sends real signed+encrypted chat; message list decrypts; **honest delivery
      states** (`sending → sent → delivered`, `queued` on no route).
- [x] **Exit demonstrated (protocol level):** two distinct identities + shared room key
      converge a verified E2EE history through cairnd; **server restart loses no history**;
      every event verifies and decrypts after restart; causal DAG links replies (heads=1).
- [x] Route (accept, no UI): `signaling_*`, `call_ring`, `call_bye` — `SubmitEvent` accepts
      and fans out any event type; no type gating.
- [x] Message interactions: reactions (CRDT, latest-per-sender), reply, edit, delete
      (tombstone) — built client-side, folded deterministically over the DAG, verified
      interop with Go for each type.
- [x] Local DAG cache in IndexedDB (offline-first render) + **bidirectional frontier sync**
      (pull the server's missing subgraph AND push what it lacks — the dual walk, §6).
- [x] `member_add` / `room_key_rotate` via **HPKE** — real multi-device key handoff.
      Ed25519→X25519 conversion (identity key doubles as the KEM key); DHKEM(X25519,
      HKDF-SHA256)/HKDF-SHA256/AES-256-GCM (circl ↔ hpke-js, interop verified both ways).
      Per-epoch room keys; pre-join history opaque; members panel (show my key / add by
      key / rotate / share key-link). Verified end-to-end: a browser member_add's wrapped
      epoch key unwraps on Go and decrypts the new epoch.
- [x] **Presence** (ephemeral — server broadcasts but never persists it; live roster +
      "N online") and **quote** (embedded snapshot, distinct from reply).
- [x] **Missing-parent backfill** (§6.4): unknown parents fetched via History so folds
      never dangle under out-of-order / partial delivery.
- [x] **Automated crypto-conformance**: golden event_id vectors asserted in both a Go test
      and `npm run conformance` — a permanent guard on the canonical-CBOR/BLAKE3 interop.
- [ ] Only outstanding: a real two-*browser* run (verified so far via Node+Go harnesses —
      this sandbox is musl and can't launch a browser). **Phase 1 is otherwise complete.**

## Phase 2 — Agents native + files + inlays

**Exit:** a capability request is delivered, rendered with its capability visible, and
signed **in the UI** into a portable grant (minting belongs to the *external* broker —
a Capsule workload in the agents system, see `decisions.md`); a novel declared inlay
renders from primitives and degrades to its text line; files send/receive with honest
retrieval states.

- [x] **In-UI capability approval.** `approval/` portable artifacts signed over their own
      canonical CBOR — a grant verifies standalone outside Cairn, with no room key.
      Request-bound + agent-bound. `ApprovalInlay` shows capability and scope always
      (no silent authorisation) and signs with your key in-page. Verified: agent request
      (Go) → grant signed via the browser path (TS) → verified by an external-broker
      stand-in (Go). Tests cover tampered capability, cross-agent replay, forged sig.
- [x] **Inlay engine.** ONE role renderer interpreting declarations as data (per
      `inlay.md`; per-card components are an anti-pattern). Full vocabulary: `record`,
      `list`, `group`, `inlay_ref` + `text`, `number`, `progress_fraction`, `status_enum`,
      `timestamp`, `image_cid`, `series`, `action_ref`, `input`, `select`. Content-addressed
      declarations (`decl_cid` = BLAKE3 of det-CBOR), standard library pre-allowlisted,
      **per-room default-deny allowlist**, mandatory text fallback, widget placeholder
      (never inline), capability-bound actions render their capability. A **novel**
      greenhouse declaration renders from primitives alone — proven by `npm run inlay-check`.
- [x] **Files.** `blobs/` with a pluggable `Backend` (`Put`/`Get`/`GetRange`/`Has`/`Pin`),
      content-addressed by BLAKE3 over the **encrypted** bytes so a store is zero-knowledge.
      `file_ref` envelope `{hash, wrapped_key, mime, size, name?}` rides chat; bytes ride the
      data plane. File cards show **honest retrieval states** (`available` / `pending — no fat
      link` / `downloading` / `broken`), composer attaches. Verified end-to-end: browser seals
      + uploads → gateway holds only ciphertext → Go fetches, verifies the content address,
      unwraps the per-file key, decrypts.
      > ⚠️ **DEVIATION:** backed by `blobs/local` (filesystem), **not** an iroh-store gRPC
      > client — no iroh-store exists in this environment. `blobs/iroh` drops in behind the
      > same interface. Full rationale in `decisions.md` §Deviations.

**Phase 2 complete** (modulo the deviation above).

## Phase 3 — Meshtastic transport + **THE DEMONSTRATION**

**Exit (headline milestone):** two devices converge a **24-hour, N-event history across
LAN ↔ mesh**; the broker approval flow works **over mesh**; **no crypto regressions vs.
Phase 1** (same conformance vectors pass). File bytes never ride mesh — envelope only.

*Measurable form:* start two nodes, partition them onto LAN and mesh-only respectively,
generate ≥ N events over 24 h (chat + one approval flow), rejoin, and assert: identical
DAG head set, every event verifies, the credential minted over mesh validates, and the
Phase-1 crypto test vectors still pass unchanged.

## Phase 4 — Multi-device delegations + identity/trust surfaces

**Exit:** pair a new device by QR; revoke a device; a Space admit-policy is enforced on
join; the recovery flow is gated and unskippable.

### Identity vertical slice — done 2026-07-18

- [x] **Household-root shape decided** (offline-only apex, BIP-39 24-word derived, never
      persisted; recovery = re-derive + re-attest). Closes the `plan.md` §5 open question.
      Rationale in `decisions.md`.
- [x] `identity/household.go` — BIP-39 mnemonic, HKDF-SHA-512 domain separation
      (`cairn/household-root/v1`), `Bootstrap`, `ProvisionMember`.
- [x] `identity/pairing.go` — versioned QR payload, fingerprints, `ApprovePairing`,
      `RevokeDevice`. Room keys are deliberately NOT in the pairing payload.
- [x] `identity/log.go` — identity log as a **set**, not a chain: order-independent
      convergence, **revocation wins**, revoked keys can never be re-paired.
- [x] **Go↔browser identity conformance**: household derivation, attestation signing bytes,
      and pairing wire format asserted against the same golden vectors in
      `identity/conformance_test.go` and `webapp/scripts/identity-conformance.ts`.
- [x] `webapp`: persistent identity vault (member root + device key in `localStorage`,
      session key still per-tab), gated onboarding (create → show 24 words → confirm three
      back), recovery flow, identity & devices surface with QR pairing and revoke.
- [x] **Member provisioning — a household is founded ONCE, everyone else joins.** Onboarding
      leads with *Join a household*; founding is behind a "nobody has set ours up yet"
      confirmation. Newcomer mints a member key → join code → an existing member re-enters the
      household words to attest it → newcomer imports the signed attestation. No secret moves
      in either direction.
      > **Trust bootstrap:** an attestation's `origin` is SELF-DECLARED, so a forged invite
      > from another household verifies its own signature perfectly. A newcomer has no trusted
      > root yet, so this cannot be settled cryptographically — the join screen shows the
      > invite's household fingerprint for out-of-band human comparison, exactly as device
      > pairing does. Do not "simplify" this away.
- [x] Session key delegated by the device key (session → device → member → household), and
      scoped to the device key so setup replaces a pre-identity throwaway key rather than
      silently carrying it forward.
- [x] **Responsive shell** (prerequisite): drawer nav under 900px, touch targets, `100dvh`.
      Verified at 390×844 and 1440×900 with zero horizontal overflow.

- [x] **Identity log persists and syncs.** New RPCs `PutIdentityObject` (carrier verifies each
      object's signature before storing) and `ResolveSender` (returns the whole chain for a
      sender key in one round trip). Clients re-verify every object locally — the server carries
      and serves, it never vouches.
      > **Protocol gap closed:** `GetIdentityObject` is keyed by HASH, but a client meeting an
      > unknown sender holds only a PUBKEY and no way to learn the hash, so hash-only lookup
      > could not bootstrap. `ResolveSender` is the pubkey-keyed entry point.
      >
      > **Type discrimination:** identity-log CBOR carries no type tag, so the carrier tries
      > each shape and keeps the one that VERIFIES — decoding alone is ambiguous because the
      > structs share field names. `identity/verify_test.go` pins that no object ever verifies
      > as another type; if that breaks, a session key could be filed as a device key.
- [x] **Sender directory**: names resolve from attested identity, verified in the browser.
      A name is shown ONLY for a chain that verifies AND terminates at our own household —
      `unknown` and `untrusted` both stay key stubs, because rendering a stranger's
      self-chosen display name is exactly how impersonation would work. Revoked devices render
      as `Name (revoked device)` rather than silently vanishing.

- [x] **Revocation propagates.** Revoking publishes the signed `DeviceRevoke` to the carrier;
      other members resolving that key get the revoke and render `Name (revoked device)`.
      A publish failure is surfaced explicitly with a retry — a revoke that silently failed to
      publish leaves everyone else trusting a key its owner believes is dead, which is worse
      than an error.

- [x] **Real rooms and spaces.** Deleted the Phase-0 `data.ts` fixture, which hardcoded a
      Household space and four channels. That fixture manufactured membership nobody had
      established: every client rendered "general" and silently minted a key for it, so two
      people in the "same" room held different keys and could not read each other.
      Rooms now come from signed `ROOM_CREATE` (enum 55) / `SPACE_CREATE` events folded into
      the `rooms`/`spaces`/`members` tables, served by `ListRooms` filtered to rooms a signed
      `MEMBER_ADD` admitted you to. An empty household shows an EMPTY sidebar.
      > **`ensureCurrentKey` is gone.** It minted a room key for any room you opened — the
      > phantom-membership engine. Replaced by `currentKey` (nullable) + `NoRoomKeyError`.
      > A key arrives exactly two ways: you created the room, or a member wrapped one to you.
- [x] **Room keys wrap to MEMBER ROOTS, not session keys.** `myKey()` returns the member root.
      Access now survives reloads and follows a member to new devices; previously an added
      member silently lost access when their tab closed.
- [x] **Device reset.** Erases identity, room keys, epochs, paired devices, session key AND the
      IndexedDB DAG cache — the cache must go too, or a "wiped" client re-uploads its history
      on reconnect. Confirmation states the three consequences (no words = household lost;
      past messages stay unreadable after rejoining; it revokes nothing).

- [x] **Live membership updates.** `ingest()` filtered every event by the room you're currently
      viewing, so a newcomer with no room open dropped their own `member_add` and sat on an
      empty screen until they happened to reload — the invite looked like it had silently
      failed. Membership events for other rooms are now handled before the room filter.
      > The room test masked this by reloading the joiner right before asserting. A test that
      > reloads before checking cannot see a missing live update.
- [x] **Optional history sharing on invite.** `member_add` takes `share_history`; when set it
      HPKE-wraps the OLDER epoch keys to the newcomer, and records `history_shared` in the
      signed payload so every member can see the backlog was disclosed. Default OFF —
      pre-join opacity stays the rule. The UI states that it cannot be undone: removing the
      member later does not take back what they can already decrypt.

- [x] **Room roster.** "Members & keys" has been named that since Phase 1 but never listed
      anyone — it held only your key, add-by-key and rotate. It now shows every member with
      their attested name, role and fingerprint. `ResolveSender` gained a member-root fallback:
      it only walked UP from a device/session key, but a roster stores member roots, which
      never sign events, so there was no chain to walk and names stayed key stubs.
- [x] **Removed the `#rk=` room-key link.** A Phase-1 shortcut from when rooms were the
      `data.ts` fixture: it installs a room KEY but cannot confer MEMBERSHIP, and the sidebar
      is now driven by signed `member_add`. A link can never work here — only an existing
      member can sign someone in. It was also a soft hazard (any URL could plant a room key).
- [x] **`cmd/agent`** — a headless Go participant proving the protocol is client-agnostic:
      creates a space/room, admits a human by member root, posts chat, declared inlays and a
      capability request, and (`-watch`) verifies the returned grant or deny STANDALONE —
      signature, expiry, and binding to the exact capability and agent. Keys default to
      `$TMPDIR/cairn-agent`, never `$HOME`: it stores a private key and plaintext room keys.

### Two-tier membership: space discovery + join requests — done 2026-07-18

- [x] **Spaces have membership, and it is the discovery tier.** `SPACE_MEMBER_ADD` (enum 56)
      admits a member root to a space and **wraps no key** — it grants the right to *see* the
      space's discoverable rooms, nothing more. Folded into `space_members`, keyed on the member
      root. This closes the recorded gap "a newcomer sees no rooms and cannot discover that any
      exist": founding a space makes the founder its first space member, and inviting a household
      member (`DevicesModal`) grants them space membership, so they arrive with the household's
      rooms visible (locked) instead of a blank sidebar. Rationale in `decisions.md`.
- [x] **`ListRooms` returns two tiers.** `core.VisibleRooms` returns rooms a `MEMBER_ADD` admitted
      you to (`joined=true`, readable) plus the discoverable rooms of every space you belong to
      (`joined=false`, locked). The sidebar renders unjoined rooms with a lock; opening one offers
      "Ask to join" rather than the dead-end no-key screen. `core/rooms_test.go` pins the matrix:
      founder sees all, a space-only member discovers only the discoverable rooms, a room-only
      member sees no siblings, a stranger sees nothing.
- [x] **Room `visibility` (`discoverable` | `hidden`, default discoverable).** A hidden room is
      returned only to someone a `MEMBER_ADD` actually admitted — space membership never reveals
      it — so a DM or private room can live in the household space without being listed to everyone.
      Selectable at room creation.
- [x] **`ROOM_JOIN_REQUEST` (enum 57).** A discoverer signs an ask into the room DAG carrying their
      member root; an existing member sees it in "Members & keys" and answers with the ordinary
      add-by-key (the only act that can wrap the key). Cleartext epoch 0 — the requester holds no
      key. "Pending" is derived (request minus roster), so a fulfilled request needs no record.
      > **Room membership is NOT a discovery grant.** Being added to one room reveals that room and
      > its space, never sibling rooms — discovery stays a deliberate `SPACE_MEMBER_ADD`. This keeps
      > the invariant that what you can see is always the result of a signed act naming you, the
      > same principle behind killing the `data.ts` phantom rooms.

### Chain gate enforced — done 2026-07-18

- [x] **The chain gate is now enforced (default-deny), and revocation is real.** `SubmitEvent`
      accepts an event only from a sender that `identity.VerifySender` chains to a trusted household
      root — no more accept-all. The open question "what does a node that trusts no root do" is
      answered by a **founding window**, not an open mode: a root-less carrier refuses events but
      accepts identity-log objects, and the **first attestation it stores adopts that household root**
      (`core.MaybeAdoptRoot`, persisted in `meta`, survives restart). `trustedRoots` in config pins
      roots and skips adoption (strict from t=0). Rationale + the TOFU-capture tradeoff in
      `decisions.md`.
      > **Error taxonomy that keeps the app working.** `ErrAwaitingFounding` / `ErrUnknownObject` →
      > `FailedPrecondition` (RECOVERABLE: publish identity and retry — how a founder's first events
      > land); revoked / untrusted / expired / bad-sig → `PermissionDenied` (TERMINAL). The webapp's
      > `deliver()` republishes-and-retries once on the former; the latter stays `queued`.
      > **Verified live:** fresh carrier logs *awaiting founding* and refuses → `cmd/smoke` founds →
      > *adopted … now ENFORCING* + event verifies → restart reloads the root and stays enforcing.
      > `core/gate_test.go` pins the four rejections (pre-founding, revoked, foreign household,
      > unknown link). `cmd/agent`/`cmd/smoke` now establish a self-household (`identity.SelfHousehold`)
      > so they pass the gate; the agent↔human demo (two households) needs both roots pinned.

### First-class spaces: create a space, then channels inside it — done 2026-07-18

- [x] **Spaces are created deliberately, and channels live inside one.** Replaced the single
      household-derived space (`householdSpaceId`, one per household, auto-created as a side effect
      of making a room) with **multiple named spaces**, each a policy boundary that holds channels —
      matching `claude-design/cairn-spaces.jsx` ("Family", "Ops" are policy, not built-in kinds) and
      the two-step create flow in `cairn-create-modals.jsx`. A space id is now unique per creation
      (`newSpaceId`), carried in the signed `SPACE_CREATE` and folded by every member, so everyone
      converges without recomputing an id — the anti-forking reason for the derived id is moot once
      creation is an explicit act.
- [x] **You cannot create a channel without a space.** `createRoom` requires an active space and no
      longer auto-creates one; the sidebar's channel "+" only appears once a space is active, and a
      brand-new household shows an empty rail whose only affordance is "Create a space". `createSpace`
      emits `SPACE_CREATE` + `SPACE_MEMBER_ADD(self, admin)`; the rail's "+" opens a `CreateSpaceModal`.
- [x] **Space selection.** Rail spaces are now clickable (`app.selectSpace`), the room list is scoped
      to the active space (`inSpace`), and inviting a member (`addSpaceMember`) grants discovery of
      the **active** space's channels. Closes the "every space is hardcoded Household / not nameable"
      gap.
- [x] **Space settings surface + member management.** A gear on the active space opens a
      `SpaceSettingsModal` (per `claude-design/cairn-spaces.jsx`): **rename** the space (wired
      `SPACE_UPDATE` — fold + builder), a **member roster** (new `ListSpaceMembers` RPC; names
      resolve from the identity log exactly like a room roster) with **add-by-key** and **remove**
      (new `SPACE_MEMBER_REMOVE` (58) → `DeleteSpaceMember`), and the **admit-policy** controls
      (agents kind, origin own/any) recorded via `SPACE_UPDATE`. `core/rooms_test.go` covers the
      rename + member-remove folds. Removing a space member revokes discovery only; it does not touch
      channels they were separately added to.
      > **Honest gap surfaced in the UI:** admit policy is **recorded but not yet enforced** — the
      > carrier does not gate a `SPACE_MEMBER_ADD` on it. The modal says so. Peer-household admission
      > (origin = specific roots, the `PeerJoinModal` flow) is deliberately deferred.

**Not yet — the rest of Phase 4:**

- [ ] Camera QR capture (`getUserMedia`); today pairing is copy/paste of the same payload.
- [ ] **Admit-policy enforcement** — a space's `admit_kind`/`admit_origin` is now editable and stored
      (see above) but nothing gates a `SPACE_MEMBER_ADD` on it; a space admin adds members by key
      regardless. Plus **peer-household join** with origin-fingerprint review (`PeerJoinModal`), and
      notifications settings.
- [ ] Parent-sets-up-kid provisioning flow (`claude-design/cairn-settings.jsx` §B).
- [ ] `approval_deny` carries a `reason` field that the UI never collects — a refusal reaches
      the agent and the audit log as a bare no.
- [ ] `cmd/agent` is not idempotent: re-running for an existing room mints a fresh key at the
      same epoch, colliding with the key members already hold.

## Phase 5 — Native wrapper (Wails3) + BLE + passkeys

**Exit:** native iOS app (simulator) with durable storage + passkey pairing; BLE
presence between two devices; approving a capability triggers a biometric ceremony.

## Phase 6 — Video / calls / vidmail

**Exit:** a 1:1 video call over the substrate signaling events; vidmail send/receive.

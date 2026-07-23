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
- [x] **Channel member removal that cuts off access.** Wired `MEMBER_REMOVE` (enum 51, previously
      unfolded) → `DeleteMember`. The Members & keys roster gets a per-member **remove** (non-self);
      `state.removeMember` **rotates the room key to the REMAINING members** and then emits the
      remove, so the removed member holds no key for the new epoch and can't read anything sent after.
      Only a room member can do it — minting the new epoch needs the current key. `foldMembers` now
      applies add/remove in timestamp order so add→remove→re-add converges; `MEMBER_REMOVE` /
      `SPACE_MEMBER_REMOVE` are handled live (the removed member's sidebar updates without a reload,
      closing the space-remove live gap). `core/rooms_test.go` covers the fold + the `joined` flip.
      > **Honest limits:** it does **not** claw back pre-removal history the member already holds
      > (keys can't be un-shared), and the system does not yet **reject** an old-epoch post a removed
      > member could still craft with a key they retain. Forward-secrecy enforcement (accept only the
      > latest epoch from current members) is a separate item.
- [x] **Space is the authority; channels enforce it.** Made space membership first-class and
      owner-controlled, with removal cascading into channels. The space **owner** (the `SPACE_CREATE`
      signer's member root, recorded at fold) is the sole authority: only they may add/remove space
      members or `SPACE_UPDATE`, **enforced at the fold** (a non-owner change is dropped) and shown
      owner-only in the UI. Space membership folds **last-writer-wins with a revocation tombstone**
      (a stale add can't resurrect a later remove). A channel roster must stay within its space
      roster (channel-add gated on space membership). **Cascade:** since only key-holders can rotate,
      the owner declares `SPACE_MEMBER_REMOVE` and channel members enforce it — each client, **on
      sync, reconciles every channel it holds a key to toward the space roster** (rotate to the
      members who stay + `MEMBER_REMOVE` for anyone no longer a space member). State-based, so it
      fires the next time any capable member syncs, even one offline during the revocation
      (`reconcileAllSpaces` on init). Rationale + honest properties in `decisions.md`;
      `core/rooms_test.go` (`TestSpaceAuthorityAndLWW`) pins owner-only + LWW.
      > **Honest limits:** eventual/online-triggered (a channel with no online members stays open
      > until one returns); creator-only (no promoting other admins yet); the client trusts the
      > owner-enforced server roster rather than re-verifying it.

### Founding moves to the CLI (`cmd/cairnctl`) — 2026-07-18

- [x] **The household's 24 words never touch a browser.** Attesting a member used to mean typing
      them into a `<textarea>`; they can vouch for anyone as anyone, and a web page is reachable
      by extensions, autofill and devtools history in a way a terminal is not. `cairnctl attest`
      replaces that form; the webapp's `bootstrap()`, household-phrase `recover()` and
      `attestJoinRequest()` are DELETED, not merely unused.
- [x] **No trust-on-first-use window.** `cairnctl init` writes the root to `trusted-roots.txt`,
      so the chain gate is strict from the FIRST event (`ENFORCING against 1 configured household
      root(s)` at boot, no adoption). `init` refuses to found twice.
      > This was not theoretical. Onboarding twice minted a second household; adoption had
      > latched onto the first, so every event from the live identity was refused as
      > `ErrUntrustedRoot` — TERMINAL, therefore not retried, therefore silently `queued`. The
      > symptom was "creating a space does nothing". That state is now unrepresentable.
- [x] **Delivery failures are shown.** `deliver()` caught rejections, marked them `queued` and
      returned NORMALLY — so `createSpace` resolved successfully and handed back an id for a
      space that did not exist. Control-plane events now use `mustLand` and throw with the
      server's own message; a banner surfaces the rest. `api.isSenderRejected` had carried the
      comment *"surface it rather than silently queueing"* since it was written, and nothing
      called it.
- [x] `identity/invite.go` — join-code and invite-blob encoding in Go, previously browser-only,
      byte-pinned by conformance vectors on both sides.
      > Building it surfaced a trap worth remembering: a plain `cbor.Marshal(map)` sorts keys
      > lexicographically where canonical CBOR sorts length-first. The result still decodes and
      > still VERIFIES — the signature covers the fields, not the envelope — while being
      > byte-different from the browser's. Use the package's canonical `Marshal`.
- [x] Everyone joins, including whoever founded the household, so the founder is no longer a
      special case in the app and holds one personal phrase like everyone else.
      > **Verified end to end on a clean node:** `cairnctl init` → `cairnd` enforcing from t=0 →
      > join code → `cairnctl attest` → invite verified in the browser's own parser → device
      > delegation published → **SPACE_CREATE accepted**.

**Still not done:** a real two-browser run. The rehearsal above uses Go harnesses that mirror the
browser paths; the actual UI flow remains unexercised at runtime.

### Delegation tree: offline member root + real device pairing — 2026-07-18

An audit of the Phase-4 exit criteria found that **device pairing could not be completed as
designed**, and that two of the claims below were overstated. Rationale in `decisions.md`
(§Member root goes offline).

- [x] **Revocation authority is checked.** `VerifySender` took a bare `DeviceRevoked(pub) bool`
      from its Resolver, and the sqlite identity log files an object under whatever subject it
      names with no check that the signer had standing — so ANY keypair could file a revoke for
      ANY device and permanently lock it out (permanently, since a revoked key can never be
      re-paired). The Resolver now returns the signed object and the chain walk checks it.
      `DeviceLog.AddRevoke` had this check; the walk could not assume its Resolver was that
      careful. `DeviceLog` also no longer DELETES the delegation on revoke — the walk needs it to
      tell "revoked" from "unknown device".
      > The browser was already correct here (`directory.svelte.ts` compared `dr.member_pub` to
      > `dd.member_pub`); the hole was Go-side only.

**Pairing was a dead end, not merely camera-less.** `admitDevice` minted a `DeviceDelegation` into
the approver's LOCAL list and never published it; there was no new-device side at all — no pending
state, no poll, no import. The new device sat on the onboarding screen forever. Nobody noticed
because the member-JOIN flow works, so a second device was usable by joining as a whole new member.
Underneath sat the real blocker: room keys wrapped to member roots, so a paired device needed the
member secret — the one thing that makes revoking it meaningless.

- [x] **Member root is an offline apex** — derived from 24 words, signs only the first device
      delegation, then dropped. Only the PUBLIC half is stored (`cairn-member-pub`). Because it is
      derived rather than random, **recovery restores the SAME member identity** instead of
      minting a stranger.
- [x] **A founder holds two separate phrases**, shown and confirmed one at a time and labelled for
      what each does: the HOUSEHOLD phrase (attests new members; can live in a safe) and their own
      MEMBER phrase (restores their account, revokes an unreachable device; must stay reachable).
      Deriving one from the other was tried and reverted — see `decisions.md` for why the
      compromise-equivalence argument does not justify it. Joiners get only a member phrase.
      Recovery splits accordingly: founders re-attest offline, everyone else fetches the
      attestation published when they joined and verifies it locally.
- [x] **Devices delegate devices.** `ParentPub` replaces `MemberPub`; `VerifySender` walks the
      tree with `MaxChainDepth = 8` and a visited set. Revocation is checked at EVERY hop, so it
      cascades to the whole subtree without naming a descendant — on every verifier, including
      ones offline at the time.
- [x] **Ancestors-only revoke authority** (`RevokerPub`). A device may retire what it paired, never
      what paired it: peer revocation would let a thief with one device permanently destroy the
      others while keeping their own. `revokeWithMemberRoot` covers the case only the words can do.
- [x] **Room keys wrap to device keys**, expanded from each member's non-revoked device tree via
      the new `ListMemberDevices` RPC (`DevicesUnder`, backed by a denormalized `parent_pub`
      column). A revoked device and its whole subtree drop out of the wrap set, so the next epoch
      excludes them. `history_keys` is now nested epoch → device.
- [x] Pairing completed end to end: the approver **publishes** the delegation (it never left the
      approver's localStorage before), the new device polls `ResolveSender`, re-verifies the whole
      chain locally, persists, and gets every held room key re-wrapped to it. Plus **camera
      capture** (`QrScanner.svelte`: `BarcodeDetector`, jsQR fallback for Safari/iOS).
- [x] Device tree UI naming who admitted whom, and a revoke dialog that lists every descendant
      that will fall with the target before confirming.
- [x] **Onboarding reload bypass fixed** as part of this: `commit()` is now called only after the
      confirmation quiz passes, so nothing reaches storage until the words are confirmed.
- [x] `SelfHousehold` (headless clients) gains a **derived device key** — one key acting as its own
      parent is a cycle the recursive walk correctly refuses. Derived, not random, so it is stable
      across runs; a fresh device key each start would lose every room key wrapped to the last one.
      > Verified live: fresh carrier → `cmd/smoke` founds and adopts → device-signed event verifies
      > and round-trips → restart reloads the root and stays ENFORCING. `cmd/agent` creates a space,
      > room and self-add, then stops with an honest error when the target member has no published
      > devices — wrapping to a member root would produce a key nobody can open.

**Honest limits of this work:**

- Two browsers have still not actually run this. Verified via Go binaries, conformance vectors and
  typecheck; the browser pairing flow is unexercised at runtime.
- Backlog is not re-wrapped on pairing: a newly paired device reads from the current epoch forward,
  not older history. Same rule as a newly added member.
- Re-keying on revoke covers rooms THIS device holds keys to. A room whose only key-holder is the
  revoked device stays readable to it until another member rotates.

**Not yet — the rest of Phase 4:**

- [ ] **Channel membership has no fold-time authorization.** `core/rooms.go` folds `MEMBER_ADD` /
      `MEMBER_REMOVE` with only a length check — no check the sender belongs to the room. The
      "a channel roster must stay within its space roster" claim above is enforced CLIENT-side only
      (`state.svelte.ts`), which is not enforcement: any household member passing the chain gate can
      sign themselves into any room, which flips `joined=true` and defeats hidden rooms. Spaces got
      `spaceChangeAuthorized`; channels got nothing.
- [ ] **Server-side channel roster is arrival-order, not LWW.** `PutMember`/`DeleteMember` carry no
      `Ts` (unlike their space equivalents), so two carriers receiving add/remove in different orders
      disagree on `ListRooms`. The timestamp-ordered convergence claimed above is the webapp's
      `foldRoster` only. Attacker-controlled `ts` also means a pre-signed far-future `MEMBER_ADD`
      resurrects a removed member on every client.
- [ ] **Onboarding gate is bypassable by reload.** `bootstrap()` persists the identity BEFORE the
      24-word confirmation quiz, so reloading at the phrase screen lands you in the app having never
      confirmed — and the mnemonic is never persisted, so it is then permanently lost. The quiz is
      real; it just guards nothing. (Being fixed with the member-root work above.)
- [ ] **Session keys expire at 24h with no renewal path.** No interval, no re-sign; at T+24h an open
      tab gets `PermissionDenied`, which the error taxonomy treats as TERMINAL, so messages sit
      permanently `queued` with no re-auth prompt.
- [ ] **Browser chain walk checks no expiry** (`directory.svelte.ts`), where Go does. Conformance
      covers signing bytes, not verification policy.
- [ ] **No way to remove a MEMBER from a household** — no `MemberRevoke` object exists.
- [ ] **Epoch downgrade** — nothing compares an incoming event's epoch to the room's current one, so
      a current member can post at an old epoch that every removed ex-member can still read. The
      outbound twin of the recorded "old-epoch post" gap.
- [ ] `ROOM_CREATE` is unauthorized w.r.t. its space: any sender can inject a channel into any
      space's sidebar.
- [ ] **Identity is not a self-DAG.** `plan.md` §175 specifies `device_delegation` / `device_revoke`
      as DAG events (`IDENTITY_ATTESTATION=60`, `DEVICE_DELEGATION=61`, `DEVICE_REVOKE=62`); what
      shipped is a content-addressed side channel (`identity_log` + `PutIdentityObject`).
      Those three enums have zero uses. Belongs in `decisions.md` §Deviations.
- [ ] Phase-1's "route, accept, no UI" commitment is not honored: `SIGNALING_*`, `CALL_RING`,
      `CALL_BYE` are not routed or enumerated anywhere.
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

// Reactive app state (Svelte 5 runes). The DAG is the truth: selecting a room
// loads history via Sync, then keeps it live over SSE. Outgoing events are signed
// + room-encrypted client-side. Derived views fold deterministically over the raw
// events (PROTOCOL.md §4): a message's rendered text = its latest edit; a
// deletion tombstones it; reactions = the union of each sender's latest set.

import { cairn, subscribe, utf8, hex, needsIdentityPublish, describeSendFailure } from './api'
import {
  buildChat,
  buildReaction,
  buildEdit,
  buildDelete,
  buildPresence,
  buildApprovalEvent,
  buildFileRef,
  roomKeyBytes,
  buildMemberAdd,
  buildMemberRemove,
  buildRoomCreate,
  buildSpaceCreate,
  buildSpaceMemberAdd,
  buildSpaceMemberRemove,
  buildSpaceUpdate,
  buildRoomJoinRequest,
  buildRoomKeyRotate,
  applyKeyEvent,
  openEvent,
  verifyEvent,
  sessionPub,
  sessionSigner,
  haveRoomKey,
  currentEpoch,
  type Decoded,
} from './crypto'
import { cachePut, cacheLoad } from './idb'
import { identity } from './identity.svelte'
import { directory } from './directory.svelte'
import { roomStore, slugify, newSpaceId } from './rooms.svelte'
import { unread } from './unread.svelte'
import { decode as cborDecode } from './cbor'
import {
  decodeRequest,
  decodeGrant,
  decodeDeny,
  decodeMinted,
  signGrant,
  signDeny,
  encodeGrant,
  encodeDeny,
  type Request as ApprovalRequest,
} from './approval'
import { learnDeclaration } from './inlay/registry'
import type { InlayInstance } from './inlay/types'
import { sealFile, type FileRef } from './files'
import { EventType, type Event } from '../gen/cairn_pb'

export type DeliveryState = 'sending' | 'sent' | 'delivered' | 'queued'

export interface ReactionAgg {
  emoji: string
  count: number
  mine: boolean
}

export interface Quote {
  text: string
  author: string
}

/** An approval request folded with whatever resolved it. */
export interface ApprovalView {
  request: ApprovalRequest
  requestIdHex: string
  capability: string
  scope: string
  params: string
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'minted'
  approver?: string
  reason?: string
  expiresAt: number
}

/** An inlay pinned to the room panel rather than the timeline. */
export interface PanelInlay {
  ev: Event
  idHex: string
  instance: InlayInstance
  author: string
  ts: number
}

export interface Msg {
  ev: Event
  idHex: string
  mine: boolean
  author: string
  ts: number
  approval?: ApprovalView // set when this row is an approval request
  inlay?: InlayInstance // set when this row is a declared inlay
  file?: { ref: FileRef; caption?: string } // set when this row is a file_ref
  body: string // current (possibly edited) text; '' when deleted
  opaque: boolean // couldn't decrypt
  edited: boolean
  deleted: boolean
  replyTo?: string // idHex of the message this replies to
  replyPreview?: string
  quote?: Quote // an embedded quotation snapshot
  reactions: ReactionAgg[]
  state: DeliveryState
}

function roomIdOf(ev: Event): string {
  return new TextDecoder().decode(ev.roomId)
}

function localHeads(evs: Event[]): Uint8Array[] {
  const isParent = new Set<string>()
  for (const e of evs) for (const p of e.parents) isParent.add(hex(p))
  return evs.filter((e) => !isParent.has(hex(e.eventId))).map((e) => e.eventId)
}

// "later" of two events: by ts, tie-broken by greater event_id (deterministic).
function laterThan(a: Event, b: Event): boolean {
  if (a.ts !== b.ts) return a.ts > b.ts
  return hex(a.eventId) > hex(b.eventId)
}

type RosterEntry = { pubHex: string; pub: Uint8Array; role: string; mine: boolean }

/**
 * Fold MEMBER_ADD / MEMBER_REMOVE into a room roster, applied in timestamp order
 * (event-id tiebreak) so add → remove → re-add converges regardless of sync
 * order. Pure over an events array so the cascade can fold a non-active room.
 */
function foldRoster(events: Event[], myMemberHex: string): RosterEntry[] {
  const byKey = new Map<string, RosterEntry>()
  const evs = events
    .filter((e) => e.type === EventType.MEMBER_ADD || e.type === EventType.MEMBER_REMOVE)
    .sort((a, b) => Number(a.ts - b.ts) || (hex(a.eventId) < hex(b.eventId) ? -1 : 1))
  for (const ev of evs) {
    try {
      // Room-state events are epoch 0: a single 0x00 frame byte, then CBOR.
      const obj = cborDecode(ev.payload.subarray(1)) as { member_pub?: Uint8Array; role?: string }
      const pub = obj.member_pub
      if (!pub || pub.length !== 32) continue
      const pubHex = hex(pub)
      if (ev.type === EventType.MEMBER_REMOVE) {
        byKey.delete(pubHex)
        continue
      }
      byKey.set(pubHex, { pubHex, pub, role: obj.role || 'member', mine: pubHex === myMemberHex })
    } catch {
      /* not a foldable membership event */
    }
  }
  return [...byKey.values()]
}

class AppState {
  // No room until one is loaded — a household starts empty and 'general' was a
  // fixture that manufactured membership nobody had established.
  currentRoomId = $state<string>('')
  // The space whose channels the sidebar is showing. Empty until a space exists
  // and is selected — a brand-new household has none, and channels can only be
  // created inside a space.
  activeSpaceId = $state<string>('')
  messages = $state<Msg[]>([])
  connected = $state<boolean>(false)
  replyingTo = $state<Msg | null>(null)
  quotingTo = $state<Msg | null>(null)
  presenceSeen = $state<Record<string, number>>({}) // sender hex → last-seen ms
  /**
   * Whether we hold a key for the current room — i.e. are really a member.
   *
   * Mirrored into reactive state because the underlying key lives in
   * localStorage, which Svelte cannot track. Without this, a key that arrives
   * via member_add AFTER mount installs correctly but the composer stays hidden.
   */
  hasRoomKey = $state(false)
  /**
   * Inlays declared with surface: 'room_panel' — the room's standing furniture
   * (an agent's status, its capabilities) rather than messages. Folded the same
   * way as timeline inlays, including inlay_update checkpoints, so a panel stays
   * current without posting anything into the conversation.
   */
  panelInlays = $state<PanelInlay[]>([])
  /** Roster for the current room, folded from member_add events. */
  members = $state<{ pubHex: string; pub: Uint8Array; role: string; mine: boolean }[]>([])
  /** Pending join requests for the current room, folded from ROOM_JOIN_REQUEST
   *  and filtered to anyone not yet admitted. Shown to members so they can
   *  answer with an add. */
  joinRequests = $state<{ pubHex: string; pub: Uint8Array; reason: string }[]>([])

  /** Members seen active within the presence window. */
  online = $derived(
    Object.entries(this.presenceSeen)
      .filter(([, t]) => Date.now() - t < 90_000)
      .map(([h]) => h),
  )

  private myPubHex = ''
  private stopSSE: (() => void) | null = null
  private events: Event[] = []
  private byId = new Map<string, Event>()
  private decoded = new Map<string, Decoded | null>()
  private states = new Map<string, DeliveryState>()
  private approvalFold: {
    grants: Map<string, { approver: string }>
    denies: Map<string, { approver: string; reason?: string }>
    minted: Set<string>
  } = { grants: new Map(), denies: new Map(), minted: new Set() }

  /**
   * Re-read the signing key after onboarding or recovery. The session key slot
   * is scoped to the device key, so completing setup swaps in a NEW session key
   * — without this the tab keeps signing (and rendering "mine") under the
   * pre-identity throwaway key it started with.
   */
  reidentify() {
    this.myPubHex = hex(sessionPub())
    this.rebuild()
    // Re-enter the app as the new identity. init() ran openFirstRoom() BEFORE
    // this device had one — during onboarding, or while a paired device was
    // still waiting for approval — so no space was ever selected and the sidebar
    // sat on "No space" even though the account belongs to several. Anything
    // that changes who we are has to redo that selection.
    void this.openFirstRoom()
  }

  init() {
    if (this.stopSSE) return
    this.myPubHex = hex(sessionPub())
    // Re-fold when a sender resolves. The fold reads identity synchronously —
    // author names, and which member root published a declaration — but
    // resolution lands afterwards, so without this the first paint's answer is
    // the permanent one. That is what left agent-published declarations sitting
    // at "declaration not allowed in this room" forever.
    directory.onResolved(() => this.rebuild())
    this.stopSSE = subscribe(
      (ev) => void this.ingest(ev),
      () => (this.connected = true),
    )
    void this.openFirstRoom()
  }

  /** Select the first room we're actually a member of, if any. A household with
   *  no rooms stays on the empty state rather than opening a phantom one. */
  async openFirstRoom() {
    await roomStore.refresh()
    this.ensureActiveSpace()
    // Coming online: drain any channel of anyone the space owner revoked while we
    // were away (state-based, so it doesn't depend on catching the event live).
    void this.reconcileAllSpaces()
    const first = roomStore.rooms[0]
    if (first) await this.selectRoom(first.id)
  }

  /** Point the sidebar at a real space: keep the current one if it still exists,
   *  else fall back to the first space we can see (or none). Called after every
   *  refresh so a stale/emptied active space never leaves the rail pointing at
   *  nothing that exists. */
  private ensureActiveSpace() {
    if (this.activeSpaceId && roomStore.spaces.some((s) => s.id === this.activeSpaceId)) return
    this.activeSpaceId = roomStore.spaces[0]?.id ?? ''
  }

  /** Switch which space the sidebar shows. Drops into that space's first channel
   *  (if any); an empty space shows the "no channels yet" state. */
  async selectSpace(id: string) {
    this.activeSpaceId = id
    const first = roomStore.inSpace(id)[0]
    if (first) await this.selectRoom(first.id)
    else this.currentRoomId = ''
  }

  /**
   * Handle a membership event for a room we are not currently viewing: install
   * the room key if it was wrapped to us, and refresh the sidebar so the room
   * appears immediately.
   */
  private async noteOutOfRoomMembership(ev: Event) {
    const me = identity.current
    if (!me) return

    // A space_member_add can make new rooms DISCOVERABLE to us (it wraps no key,
    // so there is nothing to install — just re-list). Refresh unconditionally:
    // the grant may be about us (new rooms appear) or about someone else in a
    // space we share (a no-op refresh, cheap).
    if (ev.type === EventType.SPACE_MEMBER_ADD) {
      await roomStore.refresh()
      this.ensureActiveSpace()
      return
    }

    // A join request for a room we're not viewing: refresh so its sidebar badge
    // appears immediately, rather than staying invisible until we open the room.
    // (The carrier counts pending requests per room in ListRooms.)
    if (ev.type === EventType.ROOM_JOIN_REQUEST) {
      await roomStore.refresh()
      return
    }

    // A removal (from a room or a space) can change what we can see — if it's us,
    // the room drops off or reverts to discoverable. Re-list and re-read our key
    // state so the sidebar reflects it without a reload.
    if (ev.type === EventType.MEMBER_REMOVE || ev.type === EventType.SPACE_MEMBER_REMOVE) {
      await roomStore.refresh()
      this.refreshKeyState()
      // A space revocation cascades: if we hold keys to channels in that space,
      // drain whoever the owner just removed. roomIdOf(a space event) is its id.
      if (ev.type === EventType.SPACE_MEMBER_REMOVE) void this.reconcileSpace(roomIdOf(ev))
      return
    }

    if (
      ev.type !== EventType.MEMBER_ADD &&
      ev.type !== EventType.ROOM_KEY_ROTATE &&
      ev.type !== EventType.ROOM_CREATE
    ) {
      return
    }

    if (ev.type === EventType.MEMBER_ADD || ev.type === EventType.ROOM_KEY_ROTATE) {
      // applyKeyEvent is a no-op unless this event wrapped a key to US, so it
      // doubles as the "is this about me?" check.
      //
      // ROOM_KEY_ROTATE belongs here, not just MEMBER_ADD. Now that keys wrap to
      // DEVICE keys, a rotation is how a newly paired device receives every room
      // it should be able to read — and a freshly paired device has no room open
      // yet, so dropping rotations for non-active rooms meant it sat there
      // reporting "you're not a member of this room" for rooms it had just been
      // given the key to. Membership was never the problem; the key event was
      // discarded before it could be applied.
      let installed = false
      try {
        installed = await applyKeyEvent(ev)
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e)
        return
      }
      if (!installed) return
    }
    await roomStore.refresh()
    this.refreshKeyState()
    // If we had no room open, drop into the one we were just admitted to.
    if (!this.currentRoomId) {
      const first = roomStore.rooms[0]
      if (first) await this.selectRoom(first.id)
    }
  }

  /** Re-read key availability into reactive state. */
  refreshKeyState() {
    this.hasRoomKey = !!this.currentRoomId && haveRoomKey(this.currentRoomId)
  }

  /** Recompute the roster and kick off name lookups for anyone unresolved. */
  refreshMembers() {
    this.members = this.foldMembers()
    for (const m of this.members) if (!m.mine) directory.resolveMember(m.pub)
    this.joinRequests = this.foldJoinRequests()
    for (const r of this.joinRequests) directory.resolveMember(r.pub)
  }

  /**
   * Fold ROOM_JOIN_REQUEST events into the pending-request list, dropping anyone
   * already admitted. A fulfilled request has no explicit "accepted" record — the
   * requester simply appears in `members` once someone answers with an add, so we
   * derive "still pending" by subtracting the roster.
   */
  private foldJoinRequests(): { pubHex: string; pub: Uint8Array; reason: string }[] {
    const admitted = new Set(this.foldMembers().map((m) => m.pubHex))
    const byKey = new Map<string, { pubHex: string; pub: Uint8Array; reason: string }>()
    for (const ev of this.events) {
      if (ev.type !== EventType.ROOM_JOIN_REQUEST) continue
      try {
        const obj = cborDecode(ev.payload.subarray(1)) as { member_pub?: Uint8Array; reason?: string }
        const pub = obj.member_pub
        if (!pub || pub.length !== 32) continue
        const pubHex = hex(pub)
        if (admitted.has(pubHex)) continue // already in — request satisfied
        byKey.set(pubHex, { pubHex, pub, reason: obj.reason || '' })
      } catch {
        /* not a foldable join request */
      }
    }
    return [...byKey.values()]
  }

  async selectRoom(id: string) {
    if (!id) return
    this.currentRoomId = id
    unread.markRead(id) // opening a room is what "reading" it means
    // Keep the rail in sync: opening a room (e.g. jumping to one we were just
    // admitted to) makes its space the active one.
    const room = roomStore.find(id)
    if (room?.spaceId) this.activeSpaceId = room.spaceId
    this.refreshKeyState()
    this.replyingTo = null
    this.quotingTo = null
    this.presenceSeen = {}
    this.events = []
    this.byId.clear()
    this.decoded.clear()
    this.states.clear()
    this.messages = []

    // 1. Render the local cache instantly (offline-first).
    for (const ev of await cacheLoad(id)) await this.ingest(ev, false)
    this.rebuild()

    // 2. Reconcile with the server: pull what we lack, push what it lacks.
    await this.reconcile(id)
    this.refreshKeyState()
    this.checkRoomKey(id)

    // 3. Announce presence (ephemeral — the server broadcasts, never stores it).
    void this.announcePresence()
  }

  private async announcePresence() {
    this.presenceSeen = { ...this.presenceSeen, [this.myPubHex]: Date.now() }
    try {
      await cairn.sendEvent({ event: await buildPresence(this.currentRoomId, 'online') })
    } catch {
      /* offline; presence is best-effort */
    }
  }

  /** Bidirectional frontier sync (PROTOCOL.md §6): send our heads, apply the
   *  server's missing subgraph, then push any events the server doesn't have. */
  private async reconcile(id: string) {
    try {
      const res = await cairn.sync({ roomId: utf8(id), haveHeads: localHeads(this.events) })
      this.connected = true
      for (const ev of res.missing) await this.ingest(ev, false)

      await this.backfillMissingParents()

      for (const ev of this.eventsServerLacks(res.heads)) {
        try {
          await cairn.sendEvent({ event: ev })
          if (this.states.get(hex(ev.eventId)) === 'sending') this.states.set(hex(ev.eventId), 'sent')
        } catch {
          /* still no route; stays queued */
        }
      }
      this.rebuild()
    } catch {
      this.connected = false
    }
  }

  // Backfill any parent we reference but don't hold, by walking History back
  // from it (PROTOCOL.md §6.4). Out-of-order / partial delivery is normal; this
  // keeps the DAG whole so causal folds don't dangle. Bounded to avoid loops.
  private async backfillMissingParents() {
    const missing = () => {
      const s = new Set<string>()
      for (const ev of this.events) {
        for (const p of ev.parents) {
          const ph = hex(p)
          if (!this.byId.has(ph)) s.add(ph)
        }
      }
      return s
    }
    for (let round = 0; round < 20; round++) {
      const want = missing()
      if (want.size === 0) return
      let fetched = 0
      for (const idHex of want) {
        const before = fromHex(idHex)
        if (!before) continue
        try {
          const res = await cairn.history({ roomId: utf8(this.currentRoomId), before, limit: 100 })
          for (const ev of res.events) {
            if (!this.byId.has(hex(ev.eventId))) {
              await this.ingest(ev, false)
              fetched++
            }
          }
        } catch {
          /* server may not have this ancestor either */
        }
      }
      if (fetched === 0) return // can't make progress
    }
  }

  // Events the server lacks — the dual of the server's Missing walk: from our
  // heads, walk parents down, stopping whenever we reach an event the server has
  // (its heads). Everything above that frontier is what the server is missing.
  // (Gaps below a shared head need missing-parent backfill, PROTOCOL.md §6.4 —
  // a later hardening; normal causal-order sends never produce them.)
  private eventsServerLacks(serverHeads: Uint8Array[]): Event[] {
    const stop = new Set(serverHeads.map((h) => hex(h)))
    const seen = new Set<string>()
    const out: Event[] = []
    const stack = localHeads(this.events).map((h) => hex(h))
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id) || stop.has(id)) continue
      seen.add(id)
      const e = this.byId.get(id)
      if (!e) continue
      out.push(e)
      for (const p of e.parents) stack.push(hex(p))
    }
    return out
  }

  // ---- actions ----

  /** Attach a file: encrypt locally, upload ciphertext, post the envelope. The
   *  gateway never sees plaintext; the bytes never ride mesh. */
  async sendFile(file: File, caption = '') {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const ref = await sealFile(
      roomKeyBytes(this.currentRoomId),
      bytes,
      file.type || 'application/octet-stream',
      file.name,
    )
    const ev = await buildFileRef(this.currentRoomId, ref, caption, localHeads(this.events))
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  async sendChat(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return

    const replyTo = this.replyingTo?.ev.eventId
    const q = this.quotingTo
    const quote = q
      ? { text: q.body, author: q.ev.senderPub, sourceEvent: q.ev.eventId, ts: q.ts }
      : undefined
    this.replyingTo = null
    this.quotingTo = null
    const ev = await buildChat(this.currentRoomId, { text: trimmed, replyTo, quote }, localHeads(this.events))
    this.states.set(hex(ev.eventId), 'sending')
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  /** Toggle one emoji in my reaction set for a target (CRDT: send the full set). */
  async toggleReaction(targetIdHex: string, emoji: string) {
    const target = this.byId.get(targetIdHex)
    if (!target) return
    const set = new Set(this.myReactions(targetIdHex))
    set.has(emoji) ? set.delete(emoji) : set.add(emoji)
    const ev = await buildReaction(this.currentRoomId, target.eventId, [...set], localHeads(this.events))
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  async editMessage(targetIdHex: string, text: string) {
    const target = this.byId.get(targetIdHex)
    if (!target || !text.trim()) return
    const ev = await buildEdit(this.currentRoomId, target.eventId, text.trim(), localHeads(this.events))
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  async deleteMessage(targetIdHex: string) {
    const target = this.byId.get(targetIdHex)
    if (!target) return
    const ev = await buildDelete(this.currentRoomId, target.eventId, 'author', localHeads(this.events))
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  /** Approve a capability request — signs the grant WITH YOUR KEY, right here in
   *  the UI, and emits it into the room. The agent picks the artifact up and
   *  carries it to the capability broker; Cairn mints nothing. */
  async approveRequest(req: ApprovalRequest, ttlMs = 30 * 60 * 1000) {
    const grant = signGrant(req, Date.now() + ttlMs, sessionSigner())
    const ev = await buildApprovalEvent(
      this.currentRoomId,
      EventType.APPROVAL_GRANT,
      encodeGrant(grant),
      localHeads(this.events),
    )
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  /** Deny a capability request — also a signed artifact, so the refusal is
   *  attributable and the agent can stop waiting. */
  async denyRequest(req: ApprovalRequest, reason = '') {
    const deny = signDeny(req, reason, sessionSigner())
    const ev = await buildApprovalEvent(
      this.currentRoomId,
      EventType.APPROVAL_DENY,
      encodeDeny(deny),
      localHeads(this.events),
    )
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  setReplyTo(m: Msg | null) {
    this.replyingTo = m
    if (m) this.quotingTo = null
  }

  setQuoteTo(m: Msg | null) {
    this.quotingTo = m
    if (m) this.replyingTo = null
  }

  /** My member public key (hex) — share it with a device you want added. */
  /**
   * OUR MEMBER ROOT, hex — the key someone else pastes to add us to a room.
   *
   * Not the session key: room keys are wrapped to member roots, so handing out
   * a session key would grant access that evaporates when the tab closes.
   */
  myKey(): string {
    const me = identity.current
    return me ? hex(me.memberPub) : ''
  }

  /** The current key epoch for the room (shown in the members panel). */
  epoch(): number {
    return currentEpoch(this.currentRoomId)
  }

  /** Distinct member pubkeys we've observed in this room (rough membership). */
  private distinctSenders(): Uint8Array[] {
    const seen = new Set<string>()
    const out: Uint8Array[] = []
    for (const ev of this.events) {
      const h = hex(ev.senderPub)
      if (!seen.has(h)) {
        seen.add(h)
        out.push(ev.senderPub)
      }
    }
    return out
  }

  /**
   * Member ROOTS currently in this room, folded from member_add payloads.
   *
   * Not distinctSenders(): senders are session keys, which die with the tab. A
   * room key wrapped to a session key strands that member on reload — membership
   * is a property of the member root (models.Member.MemberPub).
   */
  private roomMemberPubs(): Uint8Array[] {
    return this.foldMembers().map((m) => m.pub)
  }

  /** Fold the current room's events into its roster. */
  private foldMembers(): RosterEntry[] {
    const myMember = identity.current ? hex(identity.current.memberPub) : ''
    return foldRoster(this.events, myMember)
  }

  /**
   * Create a SPACE — a named policy boundary that holds channels. This is a
   * deliberate act (the rail's "+"), not a side effect of making a channel: the
   * creating member becomes the space's first member (admin) via a signed
   * SPACE_MEMBER_ADD, so their discovery tier reflects it exactly like everyone
   * they later invite. Returns the new space id, which becomes active.
   */
  async createSpace(name: string): Promise<string> {
    const me = identity.current
    if (!me) throw new Error('create an identity first')
    const spaceId = newSpaceId(name)
    await this.deliver(await buildSpaceCreate(spaceId, name.trim() || 'Space'), { mustLand: true })
    await this.deliver(await buildSpaceMemberAdd(spaceId, me.memberPub, 'admin'), { mustLand: true })
    await roomStore.refresh()
    this.activeSpaceId = spaceId
    return spaceId
  }

  /**
   * Create a channel INSIDE the active space: room + its first key, then a
   * member_add naming our own member root. A channel cannot exist without a
   * space — there is no auto-created space anymore; the caller must have one
   * active first.
   *
   * The creator is admitted by an explicit signed event rather than inferred
   * from authorship, so membership always has an auditable act behind it.
   */
  async createRoom(name: string, visibility: 'discoverable' | 'hidden' = 'discoverable'): Promise<string> {
    const me = identity.current
    if (!me) throw new Error('create an identity first')
    const spaceId = this.activeSpaceId
    if (!spaceId) throw new Error('create or select a space first')

    const roomId = slugify(name)

    // BUILD BOTH BEFORE SENDING EITHER.
    //
    // A room whose ROOM_CREATE landed but whose MEMBER_ADD did not is orphaned
    // for good: it shows in every sidebar as a locked room, its creator is not a
    // member, and nobody can ever be admitted because admitting requires holding
    // a key that was never wrapped to anyone. There is no delete-room event, so
    // it cannot even be cleaned up.
    //
    // buildMemberAdd is the part that can realistically fail — it mints the
    // epoch and asks the carrier which devices to wrap to — so building it first
    // means the usual failure happens while nothing has been published yet.
    const createEv = await buildRoomCreate(roomId, name.trim() || roomId, spaceId, visibility)
    const admitEv = await buildMemberAdd(roomId, me.memberPub, 'admin', [], [])

    await this.deliver(createEv, { mustLand: true })
    try {
      await this.deliver(admitEv, { mustLand: true })
    } catch (e) {
      // The narrow window where create landed and admit did not. Say exactly
      // what is wrong, because the sidebar is about to show a room that looks
      // real and cannot be entered.
      throw new Error(
        `The room was created but you could not be added to it, so it is unusable — ` +
          `nobody holds its key and nobody can be let in. Pick a different name and try ` +
          `again. (${e instanceof Error ? e.message : String(e)})`,
      )
    }

    await roomStore.refresh()
    await this.selectRoom(roomId)
    return roomId
  }

  /**
   * Grant SPACE membership to a member root in the active space — the discovery
   * tier. This is what an inviter emits so a newcomer lands with that space's
   * discoverable channels visible (locked) instead of a blank sidebar. It wraps
   * no key: it grants the ability to see and ask in, not to read anything.
   */
  async addSpaceMember(memberPub: Uint8Array, role = 'member') {
    const me = identity.current
    if (!me) throw new Error('create an identity first')
    const spaceId = this.activeSpaceId
    if (!spaceId) throw new Error('create or select a space first')
    await this.deliver(await buildSpaceMemberAdd(spaceId, memberPub, role), { mustLand: true })
    await roomStore.refresh()
  }

  /** Add a space member by their MEMBER ROOT pubkey hex (the settings modal's
   *  add-by-key). */
  async addSpaceMemberByKey(pubHex: string) {
    const pub = fromHex(pubHex.trim())
    if (!pub || pub.length !== 32) throw new Error('member key must be 64 hex chars')
    await this.addSpaceMember(pub)
  }

  /** Rename the active space and set its admit policy. Sends the full state; the
   *  fold overwrites, so the modal must pass every field. */
  async updateSpace(name: string, admitKind: string, admitOrigin: string) {
    const spaceId = this.activeSpaceId
    if (!spaceId) throw new Error('no active space')
    await this.deliver(await buildSpaceUpdate(spaceId, name.trim() || 'Space', admitKind, admitOrigin), { mustLand: true })
    await roomStore.refresh()
  }

  /** Revoke a member's discovery grant in the active space. */
  async removeSpaceMember(memberPub: Uint8Array) {
    const spaceId = this.activeSpaceId
    if (!spaceId) throw new Error('no active space')
    await this.deliver(await buildSpaceMemberRemove(spaceId, memberPub), { mustLand: true })
    await roomStore.refresh()
  }

  /**
   * Fetch the active space's roster from the carrier and kick off name lookups.
   * Names resolve the same way a room roster's do — shown only for a chain that
   * verifies to our own household. Returns key stubs until then.
   */
  async spaceMembers(
    spaceId = this.activeSpaceId,
  ): Promise<{ pubHex: string; pub: Uint8Array; role: string; mine: boolean }[]> {
    if (!spaceId) return []
    const myMember = identity.current ? hex(identity.current.memberPub) : ''
    const res = await cairn.listSpaceMembers({ spaceId: utf8(spaceId) })
    return res.members.map((m) => {
      const pubHex = hex(m.memberPub)
      if (pubHex !== myMember) directory.resolveMember(m.memberPub)
      return { pubHex, pub: m.memberPub, role: m.role || 'member', mine: pubHex === myMember }
    })
  }

  // ---- space→channel cascade (reconcile channel rosters toward the space) ----

  /**
   * Enforce the invariant "a channel roster ⊆ its space roster" for ONE channel
   * we hold the key to: anyone in the channel who is no longer a space member is
   * removed (one key rotation to the members who stay, then a MEMBER_REMOVE each).
   * This is how a space revocation reaches E2EE channel keys — only a key-holder
   * can rotate, so whichever channel member is online enacts it. Idempotent:
   * re-run finds nothing once the roster converges; concurrent enactors cost at
   * most a few extra epochs. Operates on a freshly-synced copy, so it works for a
   * channel that isn't the active one.
   */
  private async drainRoom(roomId: string, spaceId: string) {
    const me = identity.current
    if (!me || !haveRoomKey(roomId)) return // only a key-holder can rotate
    let events: Event[]
    try {
      const res = await cairn.sync({ roomId: utf8(roomId), haveHeads: [] })
      events = res.missing
    } catch {
      return // offline; try again on the next sync
    }
    const roster = foldRoster(events, hex(me.memberPub))
    const spaceSet = new Set((await this.spaceMembers(spaceId)).map((m) => m.pubHex))
    const toRemove = roster.filter((m) => !m.mine && !spaceSet.has(m.pubHex))
    if (!toRemove.length) return

    const removeSet = new Set(toRemove.map((m) => m.pubHex))
    const remaining = roster.filter((m) => !removeSet.has(m.pubHex)).map((m) => m.pub)
    const heads = localHeads(events)
    // One new epoch, wrapped only to those who stay — the removed can't read it.
    await this.deliver(await buildRoomKeyRotate(roomId, remaining, heads))
    for (const m of toRemove) {
      await this.deliver(await buildMemberRemove(roomId, m.pub, heads))
    }
    await roomStore.refresh()
  }

  /**
   * Re-wrap every room key we hold so a newly paired device of OURS can read.
   *
   * Room keys seal to device keys, so a new device starts able to decrypt
   * nothing. Rotating each room mints a fresh epoch wrapped to the full current
   * device set — which now includes the new one, since its delegation was
   * published first. We can do this alone: no other member has to be online,
   * because we already hold these keys.
   *
   * The backlog travels too. This is NOT the newly-added-member case: those
   * older epoch keys are already ours, and a paired device is the same member
   * root, so wrapping them to it discloses nothing that member cannot already
   * read on the device doing the wrapping. Adding a device and then finding an
   * empty room is a bug from where the user stands.
   */
  async rewrapForNewDevice(): Promise<{ rooms: number; failed: number }> {
    let rooms = 0
    let failed = 0
    for (const r of roomStore.rooms) {
      if (!r.joined || !haveRoomKey(r.id)) continue
      try {
        const events = r.id === this.currentRoomId ? this.events : (
          await cairn.sync({ roomId: utf8(r.id), haveHeads: [] })
        ).missing
        await this.deliver(
          await buildRoomKeyRotate(r.id, this.rosterOf(events), localHeads(events), true),
        )
        rooms++
      } catch {
        // Offline or not permitted — the new device simply can't read this room
        // yet. Counted so the UI can say so rather than implying success.
        failed++
      }
    }
    await roomStore.refresh()
    return { rooms, failed }
  }

  /** Member roots currently in a room's roster, from its folded events. */
  private rosterOf(events: Event[]): Uint8Array[] {
    const me = identity.current
    return foldRoster(events, me ? hex(me.memberPub) : '').map((m) => m.pub)
  }

  /**
   * After a room is fully synced: are we a member who nonetheless holds no key?
   *
   * This is the honest place to ask. A single key event that is not addressed to
   * us proves nothing — every event predating this device looks like that — but
   * being in the roster with no key after folding everything is a real, nameable
   * problem, and it is exactly the state a freshly paired device lands in when
   * whoever wrapped the last epoch had a stale device list.
   */
  private checkRoomKey(roomId: string) {
    const me = identity.current
    if (!me || this.currentRoomId !== roomId) return
    if (haveRoomKey(roomId)) return
    const inRoster = this.members.some((m) => m.mine)
    if (!inRoster) return // genuinely not a member; the normal locked-room state
    this.lastError =
      `You're a member of this room but this device has no key for it. That happens when the ` +
      `key was last shared before this device was added. On a device that can already read it, ` +
      `open Members & keys and hit "Rotate key" — that re-shares it to all your devices.`
  }

  /** Reconcile every channel we hold a key to in a space against its roster. */
  private async reconcileSpace(spaceId: string) {
    for (const r of roomStore.rooms) {
      if (r.spaceId === spaceId && r.joined && haveRoomKey(r.id)) {
        await this.drainRoom(r.id, spaceId)
      }
    }
  }

  /**
   * On coming online, reconcile all of our channels toward their space rosters —
   * state-based, so it catches any space revocation that happened while we were
   * away, no matter what we did or didn't see live. Best-effort and non-blocking.
   */
  async reconcileAllSpaces() {
    const spaces = new Set<string>()
    for (const r of roomStore.rooms) {
      if (r.spaceId && r.joined && haveRoomKey(r.id)) spaces.add(r.spaceId)
    }
    for (const spaceId of spaces) {
      try {
        await this.reconcileSpace(spaceId)
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * Ask to be admitted to the current room — a room we can discover but hold no
   * key for. Emits a signed ROOM_JOIN_REQUEST an existing member can answer with
   * an add; it grants nothing by itself.
   */
  async requestJoin(reason = '') {
    const me = identity.current
    if (!me) throw new Error('create an identity first')
    if (!this.currentRoomId) return
    const ev = await buildRoomJoinRequest(this.currentRoomId, me.memberPub, reason, localHeads(this.events))
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  /** Add a member by their MEMBER ROOT pubkey hex: mint a new epoch, wrap to all.
   *  A channel roster must stay within its space roster, so the target must first
   *  be a member of the room's space (only the space owner can put them there). */
  async addMember(pubHex: string, shareHistory = false) {
    const pub = fromHex(pubHex.trim())
    if (!pub || pub.length !== 32) throw new Error('member key must be 64 hex chars')
    // A channel roster must stay within its space roster. Rather than refusing
    // and telling the user to go somewhere else — which left them holding a
    // pasted key in a modal that named no route to the fix — grant the space
    // membership here when we're allowed to.
    //
    // Only the space OWNER may add space members (enforced at the fold), so a
    // non-owner still gets an error; it now says who can do it instead of
    // implying the user simply did the steps in the wrong order.
    const room = roomStore.find(this.currentRoomId)
    if (room?.spaceId) {
      const roster = await this.spaceMembers(room.spaceId)
      if (!roster.some((m) => m.pubHex === hex(pub))) {
        const space = roomStore.spaces.find((s) => s.id === room.spaceId)
        const me = identity.current
        // roomStore stores owner already hex-encoded ('' when unknown).
        const iAmOwner = !!me && !!space?.owner && space.owner === hex(me.memberPub)
        if (!iAmOwner) {
          throw new Error(
            `They're not in the space "${space?.name ?? room.spaceId}" yet, and only its owner ` +
              `can add them. Ask the person who created that space to add them, then add them here.`,
          )
        }
        // Discovery only — wraps no key. Being in the space lets them SEE the
        // space's channels; the member_add below is what grants this one.
        await this.addSpaceMember(pub)
      }
    }
    const ev = await buildMemberAdd(
      this.currentRoomId,
      pub,
      'member',
      this.roomMemberPubs(),
      localHeads(this.events),
      shareHistory,
    )
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
    await roomStore.refresh()
  }

  /**
   * Rotate the room key for the current membership.
   *
   * Shares history with our own devices, because this is the recovery path
   * checkRoomKey points people at ("hit Rotate key — that re-shares it to all
   * your devices"). A rotation that re-shared only the new epoch would leave a
   * device that paired earlier still staring at an empty room. Other members'
   * devices get nothing extra: history_keys wrap to OUR member root alone.
   */
  async rotateKey() {
    const ev = await buildRoomKeyRotate(this.currentRoomId, this.roomMemberPubs(), localHeads(this.events), true)
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  /**
   * Remove a member from the CURRENT room and cut off their future access:
   *   1. Rotate the room key to the REMAINING members — a new epoch the removed
   *      member holds no key for, so they can't read anything sent after this.
   *   2. Emit MEMBER_REMOVE so the roster drops them.
   *
   * This must be run by a room MEMBER: only a key-holder can mint the new epoch.
   * It does NOT claw back pre-removal history the member already holds — keys
   * can't be un-shared — so removal stops future reading, not past.
   */
  async removeMember(pubHex: string) {
    const me = identity.current
    if (!me) throw new Error('create an identity first')
    if (!this.currentRoomId) return
    if (pubHex === hex(me.memberPub)) throw new Error('you cannot remove yourself')
    if (!haveRoomKey(this.currentRoomId)) throw new Error('only a member can remove members')

    const remaining = this.roomMemberPubs().filter((p) => hex(p) !== pubHex)

    // 1. New epoch, wrapped to everyone who stays (never the removed member).
    const rot = await buildRoomKeyRotate(this.currentRoomId, remaining, localHeads(this.events))
    await this.ingest(rot, false)
    this.rebuild()
    await this.deliver(rot)

    // 2. Drop them from the roster.
    const pub = fromHex(pubHex)
    if (!pub) throw new Error('bad member key')
    const rem = await buildMemberRemove(this.currentRoomId, pub, localHeads(this.events))
    await this.ingest(rem, false)
    this.rebuild()
    await this.deliver(rem)
    await roomStore.refresh()
  }

  // ---- ingest + fold ----

  /**
   * The last delivery failure, in the server's own words. Rendered by the shell.
   *
   * A rejected event used to be marked `queued` and nothing else — the promise
   * resolved normally, so callers believed they had succeeded. Creating a space
   * against a carrier that refused it returned a space id for a space that did
   * not exist, closed the modal, and showed nothing at all. "Queued" is honest
   * only for something that will actually be retried; for a terminal rejection
   * it is a lie the user cannot see through.
   */
  lastError = $state<string | null>(null)

  clearError() {
    this.lastError = null
  }

  /**
   * Send an event.
   *
   * `mustLand` is for control-plane acts — creating a space or room, admitting
   * or removing a member. Those are meaningless if they do not reach the
   * carrier: nobody else can see a space that was never published, so silently
   * queueing one produces a local ghost. Those callers get a thrown error with
   * the server's message. Ordinary chat still queues, because offline-first is
   * the point there — but it records the reason instead of hiding it.
   */
  private async deliver(ev: Event, { mustLand = false }: { mustLand?: boolean } = {}) {
    const idHex = hex(ev.eventId)
    try {
      await cairn.sendEvent({ event: ev })
      if (this.states.get(idHex) === 'sending') this.states.set(idHex, 'sent')
    } catch (e) {
      // The chain gate refuses events whose sender it can't yet verify: a carrier
      // awaiting founding, or one that hasn't been handed our identity chain. That
      // is recoverable — publish our identity (which founds the household on a
      // fresh carrier) and retry once. A terminal rejection (revoked/untrusted)
      // is NOT retried; it falls through to queued so the state stays honest.
      let finalErr = e
      if (needsIdentityPublish(e)) {
        try {
          await identity.publish()
          await cairn.sendEvent({ event: ev })
          if (this.states.get(idHex) === 'sending') this.states.set(idHex, 'sent')
          this.rebuild()
          return
        } catch (retryErr) {
          finalErr = retryErr // report what the RETRY said, not the first refusal
        }
      }
      this.states.set(idHex, 'queued')
      const msg = describeSendFailure(finalErr)
      this.lastError = msg
      this.rebuild()
      if (mustLand) throw new Error(msg)
      return
    }
    this.rebuild()
  }

  /** Verify, decrypt, and record an event. rebuild=true folds immediately (live path). */
  private async ingest(ev: Event, rebuild = true) {
    // Membership events for OTHER rooms must be handled before the room filter.
    // Being added to a room you aren't currently viewing is the normal case —
    // dropping those events meant a newcomer sat on an empty screen until they
    // happened to reload, which looked like the invite had silently failed.
    const evRoom = roomIdOf(ev)
    if (evRoom !== this.currentRoomId) {
      // Activity in a room you aren't looking at is exactly what an unread
      // badge is for — previously this path dropped it and the client never
      // learned a message had arrived at all.
      if (unread.note(ev, evRoom, hex(ev.senderPub) === this.myPubHex)) {
        void roomStore.refresh() // so a room you can see badges immediately
      }
      await this.noteOutOfRoomMembership(ev)
      return
    }

    // Learn who this sender is (async, verified locally). Until it resolves the
    // row renders an honest key stub rather than an unverified name.
    if (hex(ev.senderPub) !== this.myPubHex) directory.resolve(ev.senderPub)

    // Presence is ephemeral: update the live roster, never store it in the DAG.
    if (ev.type === EventType.PRESENCE) {
      if (!verifyEvent(ev)) return
      const d = await openEvent(ev)
      if (d?.kind === 'presence' && d.state === 'online') {
        this.presenceSeen = { ...this.presenceSeen, [hex(ev.senderPub)]: Date.now() }
      }
      return
    }

    const idHex = hex(ev.eventId)

    if (this.byId.has(idHex)) {
      // Our own event echoed back by the server = delivered (path unknown).
      if (this.states.get(idHex) === 'sent') {
        this.states.set(idHex, 'delivered')
        if (rebuild) this.rebuild()
      }
      return
    }
    if (!verifyEvent(ev)) return // drop malformed / bad-sig

    this.events.push(ev)
    this.byId.set(idHex, ev)

    // Key-material events: install our epoch key first, then re-decrypt anything
    // that was opaque for lack of it (pre-key events now become readable).
    if (ev.type === EventType.MEMBER_ADD || ev.type === EventType.ROOM_KEY_ROTATE) {
      try {
        if (await applyKeyEvent(ev)) {
          await this.redecryptOpaque()
          this.refreshKeyState()
        }
      } catch (e) {
        // A key event meant for us that we could not apply is exactly how a
        // device ends up showing "you're not a member" of a room it was just
        // given access to. Say so, rather than letting it look identical to
        // never having been admitted.
        this.lastError = e instanceof Error ? e.message : String(e)
      }
    }

    // Trust-by-author decides whether a published declaration may render, and the
    // fold reads the directory synchronously. This one type therefore waits for
    // resolution instead of firing and forgetting — otherwise the author is
    // unknown at first paint and nothing ever re-folds to correct it.
    if (ev.type === EventType.INLAY_DECL && hex(ev.senderPub) !== this.myPubHex) {
      await directory.resolveAwait(ev.senderPub)
    }

    this.decoded.set(idHex, await openEvent(ev))
    void cachePut(idHex, this.currentRoomId, ev) // local-first: persist for offline
    if (rebuild) this.rebuild()
  }

  private async redecryptOpaque() {
    for (const ev of this.events) {
      const idHex = hex(ev.eventId)
      if (this.decoded.get(idHex) === null) this.decoded.set(idHex, await openEvent(ev))
    }
  }

  private myReactions(targetIdHex: string): string[] {
    let latest: Event | null = null
    let emoji: string[] = []
    for (const ev of this.events) {
      const d = this.decoded.get(hex(ev.eventId))
      if (d?.kind !== 'reaction') continue
      if (hex(d.target) !== targetIdHex) continue
      if (hex(ev.senderPub) !== this.myPubHex) continue
      if (!latest || laterThan(ev, latest)) {
        latest = ev
        emoji = d.emoji
      }
    }
    return emoji
  }

  /** Fold the raw DAG into the rendered message list. */
  private rebuild() {
    this.refreshMembers()
    // Approval fold: a request is pending until a grant/deny/minted with the
    // same request_id lands. Resolution is by request_id, not causal position,
    // because the artifacts are portable and may arrive by any path.
    const grants = new Map<string, { approver: string }>()
    const denies = new Map<string, { approver: string; reason?: string }>()
    const minted = new Set<string>()
    for (const ev of this.events) {
      const d = this.decoded.get(hex(ev.eventId))
      if (d?.kind === 'approval_grant') {
        const g = decodeGrant(d.raw)
        if (g) grants.set(hex(g.request_id), { approver: hex(g.approver_pub) })
      } else if (d?.kind === 'approval_deny') {
        const dn = decodeDeny(d.raw)
        if (dn) denies.set(hex(dn.request_id), { approver: hex(dn.approver_pub), reason: dn.reason })
      } else if (d?.kind === 'credential_minted') {
        const m = decodeMinted(d.raw)
        if (m) minted.add(hex(m.request_id))
      }
    }
    this.approvalFold = { grants, denies, minted }

    const latestEdit = new Map<string, { ev: Event; text: string }>()
    const deleted = new Set<string>()
    // target -> sender -> { ev, emoji }
    const reacts = new Map<string, Map<string, { ev: Event; emoji: string[] }>>()
    // target -> every checkpoint for it. Unlike an edit, an inlay_update is not
    // last-writer-wins: each one carries only the keys that changed, so the whole
    // series has to replay in order to reach the current state.
    const inlayUpdates = new Map<string, { ev: Event; state: Record<string, unknown> }[]>()
    // decl_cid -> the newest panel-surface instance of it.
    const panels = new Map<string, PanelInlay>()

    for (const ev of this.events) {
      const d = this.decoded.get(hex(ev.eventId))
      if (!d) continue
      if (d.kind === 'inlay_update') {
        const t = hex(d.target)
        const list = inlayUpdates.get(t) ?? []
        list.push({ ev, state: d.state })
        inlayUpdates.set(t, list)
      } else if (d.kind === 'edit') {
        const t = hex(d.target)
        const cur = latestEdit.get(t)
        if (!cur || laterThan(ev, cur.ev)) latestEdit.set(t, { ev, text: d.text })
      } else if (d.kind === 'delete') {
        deleted.add(hex(d.target))
      } else if (d.kind === 'reaction') {
        const t = hex(d.target)
        const senders = reacts.get(t) ?? new Map()
        const sh = hex(ev.senderPub)
        const cur = senders.get(sh)
        if (!cur || laterThan(ev, cur.ev)) senders.set(sh, { ev, emoji: d.emoji })
        reacts.set(t, senders)
      }
    }

    // this.events is in arrival order, which for a replayed checkpoint series is
    // not the order the author sent them in. Replaying out of order would let a
    // stale tick win, so put each series back into send order before folding.
    for (const list of inlayUpdates.values()) {
      list.sort((a, b) => (laterThan(a.ev, b.ev) ? 1 : -1))
    }

    const msgs: Msg[] = []
    for (const ev of this.events) {
      const idHex = hex(ev.eventId)
      const d = this.decoded.get(idHex)
      // A file_ref renders as a file card with honest retrieval states.
      if (d?.kind === 'file') {
        msgs.push({
          ev,
          idHex,
          mine: hex(ev.senderPub) === this.myPubHex,
          author: identity.nameFor(hex(ev.senderPub), this.myPubHex),
          ts: Number(ev.ts),
          body: d.caption ?? '',
          opaque: false,
          edited: false,
          deleted: false,
          reactions: [],
          state: this.states.get(idHex) ?? 'delivered',
          file: { ref: d.ref, caption: d.caption },
        })
        continue
      }

      // A published declaration is not a message — it is vocabulary. Learn it
      // (the hash is verified inside) and render nothing for it, so a room that
      // uses agent-authored UI isn't littered with plumbing rows.
      if (d?.kind === 'inlay_decl') {
        const senderHex = hex(ev.senderPub)
        // Our own sender key is never in the directory (we don't resolve
        // ourselves), so read our member root directly or our own declarations
        // would be the one case that never renders.
        const authorHex =
          senderHex === this.myPubHex
            ? (identity.current ? hex(identity.current.memberPub) : '')
            : (() => {
                const t = directory.get(senderHex)
                return t.state === 'verified' ? hex(t.memberPub) : ''
              })()
        learnDeclaration(d.decl as never, authorHex)
        continue
      }

      // A declared inlay renders through the role renderer (or degrades to its
      // mandatory text line).
      if (d?.kind === 'inlay') {
        // Only the instance's own author may check it in: an inlay renders as
        // that author's UI, so accepting a stranger's state would let anyone
        // repaint someone else's progress bar or approval row.
        const updates = (inlayUpdates.get(idHex) ?? []).filter(
          (u) => hex(u.ev.senderPub) === hex(ev.senderPub),
        )
        // Merge shallowly and into a fresh object: the decoded payload is cached
        // across rebuilds, so folding in place would compound old checkpoints.
        // Only bindings move — text stays the instance's original fallback.
        const instance = updates.length
          ? {
              ...d.instance,
              bindings: updates.reduce(
                (acc, u) => ({ ...acc, ...u.state }),
                { ...(d.instance.bindings ?? {}) } as Record<string, unknown>,
              ),
            }
          : d.instance

        // surface: 'room_panel' means "this is room furniture, not a message".
        // A status panel that scrolled away with the conversation would be
        // useless the moment anyone spoke, so it goes to the side panel and is
        // deliberately kept OUT of the timeline. Latest instance per declaration
        // wins: an agent that re-posts its panel is replacing it, not stacking a
        // second copy beside the first.
        if (instance.surface === 'room_panel') {
          const prev = panels.get(instance.decl_cid)
          if (!prev || laterThan(ev, prev.ev)) {
            panels.set(instance.decl_cid, {
              ev,
              idHex,
              instance,
              author: identity.nameFor(hex(ev.senderPub), this.myPubHex),
              ts: Number(ev.ts),
            })
          }
          continue
        }

        msgs.push({
          ev,
          idHex,
          mine: hex(ev.senderPub) === this.myPubHex,
          author: identity.nameFor(hex(ev.senderPub), this.myPubHex),
          ts: Number(ev.ts),
          body: d.instance.text,
          opaque: false,
          edited: false,
          deleted: false,
          reactions: [],
          state: this.states.get(idHex) ?? 'delivered',
          inlay: instance,
        })
        continue
      }

      // An approval request renders as its own inlay row, folded with whatever
      // resolved it.
      if (d?.kind === 'approval_request') {
        const req = decodeRequest(d.raw)
        if (!req) continue
        const ridHex = hex(req.request_id)
        const g = this.approvalFold.grants.get(ridHex)
        const dn = this.approvalFold.denies.get(ridHex)
        let aState: ApprovalView['state'] = 'pending'
        if (this.approvalFold.minted.has(ridHex)) aState = 'minted'
        else if (g) aState = 'approved'
        else if (dn) aState = 'denied'
        else if (req.expires_at && Date.now() > req.expires_at) aState = 'expired'

        msgs.push({
          ev,
          idHex,
          mine: hex(ev.senderPub) === this.myPubHex,
          author: identity.nameFor(hex(ev.senderPub), this.myPubHex),
          ts: Number(ev.ts),
          body: '',
          opaque: false,
          edited: false,
          deleted: false,
          reactions: [],
          state: this.states.get(idHex) ?? 'delivered',
          approval: {
            request: req,
            requestIdHex: ridHex,
            capability: req.capability.name,
            scope: req.capability.scope ?? '',
            params: req.capability.params
              ? Object.entries(req.capability.params)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' · ')
              : '',
            state: aState,
            approver: g?.approver ?? dn?.approver,
            reason: dn?.reason,
            expiresAt: req.expires_at,
          },
        })
        continue
      }

      // Only chats render as message rows; edits/reactions/deletes fold into them
      // above. An undecryptable CHAT still gets a row (shown opaque/locked).
      const isChat = d?.kind === 'chat'
      const isOpaqueChat = d === null && ev.type === EventType.CHAT
      if (!isChat && !isOpaqueChat) continue

      const isDeleted = deleted.has(idHex)
      const edit = latestEdit.get(idHex)
      const body = isDeleted ? '' : (edit?.text ?? (d?.kind === 'chat' ? d.text : ''))

      // reactions
      const agg = new Map<string, ReactionAgg>()
      for (const [sender, r] of reacts.get(idHex) ?? []) {
        for (const e of r.emoji) {
          const a = agg.get(e) ?? { emoji: e, count: 0, mine: false }
          a.count++
          if (sender === this.myPubHex) a.mine = true
          agg.set(e, a)
        }
      }

      // reply preview
      let replyTo: string | undefined
      let replyPreview: string | undefined
      if (d?.kind === 'chat' && d.replyTo) {
        replyTo = hex(d.replyTo)
        const rt = this.decoded.get(replyTo)
        const rEdit = latestEdit.get(replyTo)
        const rBody = rEdit?.text ?? (rt?.kind === 'chat' ? rt.text : '')
        replyPreview = rBody ? truncate(rBody, 80) : '(message)'
      }

      // embedded quote snapshot
      let quote: Quote | undefined
      if (d?.kind === 'chat' && d.quote) {
        quote = { text: d.quote.text, author: 'cairn:' + hex(d.quote.author).slice(0, 6) }
      }

      msgs.push({
        ev,
        idHex,
        mine: hex(ev.senderPub) === this.myPubHex,
        author: identity.nameFor(hex(ev.senderPub), this.myPubHex),
        ts: Number(ev.ts),
        body,
        opaque: d === null,
        edited: !!edit && !isDeleted,
        deleted: isDeleted,
        replyTo,
        replyPreview,
        quote,
        reactions: [...agg.values()].sort((a, b) => a.emoji.localeCompare(b.emoji)),
        state: this.states.get(idHex) ?? 'delivered',
      })
    }

    msgs.sort((a, b) => a.ts - b.ts || (a.idHex < b.idHex ? -1 : 1))
    this.messages = msgs
    // Oldest first, so a panel does not jump position every time it checkpoints.
    this.panelInlays = [...panels.values()].sort((a, b) => a.ts - b.ts)
  }

  dispose() {
    this.stopSSE?.()
    this.stopSSE = null
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function fromHex(h: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) return null
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const app = new AppState()

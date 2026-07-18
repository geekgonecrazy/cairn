// Reactive app state (Svelte 5 runes). The DAG is the truth: selecting a room
// loads history via Sync, then keeps it live over SSE. Outgoing events are signed
// + room-encrypted client-side. Derived views fold deterministically over the raw
// events (PROTOCOL.md §4): a message's rendered text = its latest edit; a
// deletion tombstones it; reactions = the union of each sender's latest set.

import { cairn, subscribe, utf8, hex } from './api'
import {
  buildChat,
  buildReaction,
  buildEdit,
  buildDelete,
  buildPresence,
  buildApprovalEvent,
  buildInlay,
  buildMemberAdd,
  buildRoomKeyRotate,
  applyKeyEvent,
  openEvent,
  verifyEvent,
  importRoomKeyFromHash,
  sessionPub,
  sessionSigner,
  roomKeyLink,
  currentEpoch,
  type Decoded,
} from './crypto'
import { cachePut, cacheLoad } from './idb'
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
import { SAMPLES } from './inlay/samples'
import type { InlayInstance } from './inlay/types'
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

export interface Msg {
  ev: Event
  idHex: string
  mine: boolean
  author: string
  ts: number
  approval?: ApprovalView // set when this row is an approval request
  inlay?: InlayInstance // set when this row is a declared inlay
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

class AppState {
  currentRoomId = $state<string>('general')
  messages = $state<Msg[]>([])
  connected = $state<boolean>(false)
  replyingTo = $state<Msg | null>(null)
  quotingTo = $state<Msg | null>(null)
  presenceSeen = $state<Record<string, number>>({}) // sender hex → last-seen ms

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

  init() {
    if (this.stopSSE) return
    importRoomKeyFromHash()
    this.myPubHex = hex(sessionPub())
    this.stopSSE = subscribe(
      (ev) => void this.ingest(ev),
      () => (this.connected = true),
    )
    void this.selectRoom(this.currentRoomId)
  }

  async selectRoom(id: string) {
    this.currentRoomId = id
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

  /** Post a declared inlay (dev affordance: `/inlay <name>` in the composer). */
  async postInlay(name: string) {
    const sample = SAMPLES[name]
    if (!sample) return
    const ev = await buildInlay(this.currentRoomId, sample, localHeads(this.events))
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  async sendChat(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return

    // `/inlay <name>` posts a declared inlay instead of a chat message.
    if (trimmed.startsWith('/inlay')) {
      await this.postInlay(trimmed.split(/\s+/)[1] ?? 'greenhouse')
      return
    }
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
  myKey(): string {
    return this.myPubHex
  }

  /** A shareable room-key link (dev handoff) for the current room + epoch. */
  keyLink(): string {
    return roomKeyLink(this.currentRoomId)
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

  /** Add a member by their pubkey hex: mint a new epoch, wrap it to everyone. */
  async addMember(pubHex: string) {
    const pub = fromHex(pubHex.trim())
    if (!pub || pub.length !== 32) throw new Error('member key must be 64 hex chars')
    const ev = await buildMemberAdd(this.currentRoomId, pub, 'member', this.distinctSenders(), localHeads(this.events))
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  /** Rotate the room key for the current membership. */
  async rotateKey() {
    const ev = await buildRoomKeyRotate(this.currentRoomId, this.distinctSenders(), localHeads(this.events))
    await this.ingest(ev, false)
    this.rebuild()
    await this.deliver(ev)
  }

  // ---- ingest + fold ----

  private async deliver(ev: Event) {
    const idHex = hex(ev.eventId)
    try {
      await cairn.sendEvent({ event: ev })
      if (this.states.get(idHex) === 'sending') this.states.set(idHex, 'sent')
    } catch {
      this.states.set(idHex, 'queued')
    }
    this.rebuild()
  }

  /** Verify, decrypt, and record an event. rebuild=true folds immediately (live path). */
  private async ingest(ev: Event, rebuild = true) {
    if (roomIdOf(ev) !== this.currentRoomId) return

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
      if (await applyKeyEvent(ev)) await this.redecryptOpaque()
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

    for (const ev of this.events) {
      const d = this.decoded.get(hex(ev.eventId))
      if (!d) continue
      if (d.kind === 'edit') {
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

    const msgs: Msg[] = []
    for (const ev of this.events) {
      const idHex = hex(ev.eventId)
      const d = this.decoded.get(idHex)
      // A declared inlay renders through the role renderer (or degrades to its
      // mandatory text line).
      if (d?.kind === 'inlay') {
        msgs.push({
          ev,
          idHex,
          mine: hex(ev.senderPub) === this.myPubHex,
          author: 'cairn:' + hex(ev.senderPub).slice(0, 6),
          ts: Number(ev.ts),
          body: d.instance.text,
          opaque: false,
          edited: false,
          deleted: false,
          reactions: [],
          state: this.states.get(idHex) ?? 'delivered',
          inlay: d.instance,
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
          author: 'cairn:' + hex(ev.senderPub).slice(0, 6),
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
        author: 'cairn:' + hex(ev.senderPub).slice(0, 6),
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

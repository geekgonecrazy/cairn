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
  openEvent,
  verifyEvent,
  importRoomKeyFromHash,
  sessionPub,
  type Decoded,
} from './crypto'
import { EventType, type Event } from '../gen/cairn_pb'

export type DeliveryState = 'sending' | 'sent' | 'delivered' | 'queued'

export interface ReactionAgg {
  emoji: string
  count: number
  mine: boolean
}

export interface Msg {
  ev: Event
  idHex: string
  mine: boolean
  author: string
  ts: number
  body: string // current (possibly edited) text; '' when deleted
  opaque: boolean // couldn't decrypt
  edited: boolean
  deleted: boolean
  replyTo?: string // idHex of the message this replies to
  replyPreview?: string
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

  private myPubHex = ''
  private stopSSE: (() => void) | null = null
  private events: Event[] = []
  private byId = new Map<string, Event>()
  private decoded = new Map<string, Decoded | null>()
  private states = new Map<string, DeliveryState>()

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
    this.events = []
    this.byId.clear()
    this.decoded.clear()
    this.states.clear()
    this.messages = []
    try {
      const res = await cairn.sync({ roomId: utf8(id) })
      this.connected = true
      for (const ev of res.missing) await this.ingest(ev, false)
      this.rebuild()
    } catch {
      this.connected = false
    }
  }

  // ---- actions ----

  async sendChat(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    const replyTo = this.replyingTo?.ev.eventId
    this.replyingTo = null
    const ev = await buildChat(this.currentRoomId, { text: trimmed, replyTo }, localHeads(this.events))
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

  setReplyTo(m: Msg | null) {
    this.replyingTo = m
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
    this.decoded.set(idHex, await openEvent(ev))
    if (rebuild) this.rebuild()
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

export const app = new AppState()

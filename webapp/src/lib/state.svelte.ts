// Reactive app state (Svelte 5 runes). The DAG is the truth: selecting a room
// loads its history via Sync (a frontier diff from empty = everything), then
// keeps it live over SSE. Outgoing chats are signed + room-encrypted client-side
// and sent via SendEvent; a dropped SSE frame is harmless — the next Sync
// reconciles. Message delivery states are honest (no fake "delivered").

import { cairn, subscribe, utf8, hex } from './api'
import { buildChat, openChat, verifyEvent, importRoomKeyFromHash, sessionPub } from './crypto'
import type { Event } from '../gen/cairn_pb'

export type DeliveryState = 'sending' | 'sent' | 'delivered' | 'queued'

export interface Msg {
  ev: Event
  idHex: string
  mine: boolean
  body: string | null // decrypted text, or null if opaque/undecryptable
  state: DeliveryState
}

function roomIdOf(ev: Event): string {
  return new TextDecoder().decode(ev.roomId)
}

// Local heads = event ids that are nobody's parent among the events we hold.
function localHeads(evs: Event[]): Uint8Array[] {
  const isParent = new Set<string>()
  for (const e of evs) for (const p of e.parents) isParent.add(hex(p))
  return evs.filter((e) => !isParent.has(hex(e.eventId))).map((e) => e.eventId)
}

class AppState {
  currentRoomId = $state<string>('general')
  messages = $state<Msg[]>([])
  connected = $state<boolean>(false)

  private myPubHex = ''
  private stopSSE: (() => void) | null = null
  private events: Event[] = [] // raw DAG for head computation

  init() {
    if (this.stopSSE) return
    importRoomKeyFromHash()
    this.myPubHex = hex(sessionPub())
    this.stopSSE = subscribe(
      (ev) => void this.ingest(ev, 'delivered'),
      () => (this.connected = true),
    )
    void this.selectRoom(this.currentRoomId)
  }

  async selectRoom(id: string) {
    this.currentRoomId = id
    this.messages = []
    this.events = []
    try {
      const res = await cairn.sync({ roomId: utf8(id) })
      this.connected = true
      for (const ev of res.missing) await this.ingest(ev, 'delivered')
    } catch {
      this.connected = false
    }
  }

  /** Build, sign, encrypt, and send a chat. Optimistic, with honest states. */
  async sendChat(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    const roomId = this.currentRoomId
    const parents = localHeads(this.events)
    const ev = await buildChat(roomId, { text: trimmed }, parents)

    // Optimistic insert.
    this.events = [...this.events, ev]
    const msg: Msg = { ev, idHex: hex(ev.eventId), mine: true, body: trimmed, state: 'sending' }
    this.messages = [...this.messages, msg]

    try {
      await cairn.sendEvent({ event: ev })
      this.setState(msg.idHex, 'sent') // server stored it
    } catch {
      this.setState(msg.idHex, 'queued') // no route — real state, not a lie
    }
  }

  /** Verify, decrypt, and merge an inbound event; dedup by id. */
  private async ingest(ev: Event, arrival: DeliveryState) {
    if (roomIdOf(ev) !== this.currentRoomId) return
    if (!verifyEvent(ev)) return // drop malformed / bad-sig events

    const idHex = hex(ev.eventId)
    const existing = this.messages.find((m) => m.idHex === idHex)
    if (existing) {
      // Our own event echoed back by the server = delivered (path unknown).
      if (existing.mine && existing.state === 'sent') this.setState(idHex, 'delivered')
      return
    }

    this.events = [...this.events, ev]
    const body = await openChat(ev)
    const mine = hex(ev.senderPub) === this.myPubHex
    this.messages = [
      ...this.messages,
      { ev, idHex, mine, body: body?.text ?? null, state: arrival },
    ]
  }

  private setState(idHex: string, state: DeliveryState) {
    this.messages = this.messages.map((m) => (m.idHex === idHex ? { ...m, state } : m))
  }

  dispose() {
    this.stopSSE?.()
    this.stopSSE = null
  }
}

export const app = new AppState()

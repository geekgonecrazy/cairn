// Reactive app state (Svelte 5 runes). Holds the selected room, its events, and
// realtime connection status. The DAG is the truth: on selecting a room we load
// its history via Sync (a frontier diff from empty = everything), then keep it
// live over SSE. A dropped SSE frame is harmless — the next Sync reconciles.

import { cairn, subscribe, utf8 } from './api'
import type { Event } from '../gen/cairn_pb'

function roomIdOf(ev: Event): string {
  return new TextDecoder().decode(ev.roomId)
}

class AppState {
  currentRoomId = $state<string>('general')
  events = $state<Event[]>([])
  connected = $state<boolean>(false)
  private stopSSE: (() => void) | null = null

  /** Start the realtime stream (once). Incoming events for the current room are
   *  appended live. */
  init() {
    if (this.stopSSE) return
    this.stopSSE = subscribe(
      (ev) => {
        if (roomIdOf(ev) !== this.currentRoomId) return
        if (this.events.some((e) => eqBytes(e.eventId, ev.eventId))) return
        this.events = [...this.events, ev]
      },
      () => {
        this.connected = true
      },
    )
    void this.selectRoom(this.currentRoomId)
  }

  /** Switch rooms and (re)load history from the server. */
  async selectRoom(id: string) {
    this.currentRoomId = id
    this.events = []
    try {
      const res = await cairn.sync({ roomId: utf8(id) })
      // Sync returns missing best-effort oldest-first; keep that order.
      this.events = res.missing
      this.connected = true
    } catch {
      this.connected = false
    }
  }

  dispose() {
    this.stopSSE?.()
    this.stopSSE = null
  }
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export const app = new AppState()

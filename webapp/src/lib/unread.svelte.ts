// Per-room unread tracking.
//
// The read marker is LOCAL and per-device: "I have seen this" is a property of a
// pair of eyes, not of the household. Syncing it would mean a new event type and
// would leak reading habits to every member; a per-device marker is the honest
// default until there's a reason to do otherwise.
//
// Counting only starts once the client has seen an event, and events for rooms
// you aren't viewing only arrive while the app is open (SSE). So a room that
// received messages while you were away shows as unread from the first event
// after you reconnect, not from the full backlog — see the note on `seed`.

import { hex } from './api'
import type { Event } from '../gen/cairn_pb'
import { EventType } from '../gen/cairn_pb'

const LAST_READ = 'cairn-lastread:'

/** Event types that constitute "activity someone should notice". Membership and
 *  key churn are not: being re-keyed is not a message. */
function isActivity(type: EventType): boolean {
  switch (type) {
    case EventType.CHAT:
    case EventType.FILE_REF:
    case EventType.INLAY:
    case EventType.APPROVAL_REQUEST:
      return true
    default:
      return false
  }
}

class UnreadState {
  /** roomId → count of unread activity events. */
  private counts = $state<Record<string, number>>({})
  /** roomId → ts of the newest activity we've seen, so a reload can compare. */
  private latest = new Map<string, number>()

  count(roomId: string): number {
    return this.counts[roomId] ?? 0
  }

  total(roomIds: string[]): number {
    return roomIds.reduce((n, id) => n + this.count(id), 0)
  }

  private lastRead(roomId: string): number {
    return Number(localStorage.getItem(LAST_READ + roomId) ?? '0')
  }

  /**
   * Note an event that arrived for a room. Returns true if it counted.
   *
   * `mine` events never count — you don't have unread messages from yourself —
   * and neither does anything at or before the room's read marker, so replayed
   * history during sync doesn't resurrect counts you already cleared.
   */
  note(ev: Event, roomId: string, mine: boolean): boolean {
    if (mine || !isActivity(ev.type)) return false
    const ts = Number(ev.ts)
    if (ts <= this.lastRead(roomId)) return false

    const prev = this.latest.get(roomId) ?? 0
    if (ts > prev) this.latest.set(roomId, ts)

    this.counts = { ...this.counts, [roomId]: (this.counts[roomId] ?? 0) + 1 }
    return true
  }

  /** Mark a room read up to the newest event we've seen in it. */
  markRead(roomId: string) {
    if (!roomId) return
    const ts = Math.max(this.latest.get(roomId) ?? 0, Date.now())
    localStorage.setItem(LAST_READ + roomId, String(ts))
    if (this.counts[roomId]) {
      const next = { ...this.counts }
      delete next[roomId]
      this.counts = next
    }
  }

  /** Drop all counts (e.g. identity reset) without touching the stored markers. */
  clear() {
    this.counts = {}
    this.latest.clear()
  }
}

export const unread = new UnreadState()
export { hex }

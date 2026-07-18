// The room directory — real state, fetched from the carrier.
//
// This replaces the Phase-0 `data.ts` fixture, which hardcoded a Household space
// and four channels. That fixture manufactured membership nobody had
// established: every client rendered "general", silently minted a key for it,
// and two people in the "same" room held different keys. Rooms now exist only
// because someone emitted a signed ROOM_CREATE, and you see one only because a
// signed MEMBER_ADD put you in it.
//
// An empty household therefore shows an EMPTY sidebar. That is correct, not a
// loading state.

import { cairn, hex, utf8 } from './api'
import { identity } from './identity.svelte'

export type RoomKind = 'room' | 'dm' | 'agent'

export interface Room {
  id: string
  name: string
  kind: RoomKind
  spaceId: string
  createdAt: number
  /** True when a MEMBER_ADD wrapped the room key to us — we can read it. False
   *  for a room we can only DISCOVER through space membership (shown locked). */
  joined: boolean
  /** "discoverable" (visible to all space members) | "hidden" (members only). */
  visibility: string
}

export interface Space {
  id: string
  name: string
  /** 1–2 char rail glyph, derived from the name (no separate stored field). */
  label: string
}

const dec = new TextDecoder()

function glyphFor(name: string): string {
  const trimmed = name.trim()
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?'
}

class RoomStore {
  rooms = $state<Room[]>([])
  spaces = $state<Space[]>([])
  /** False until the first fetch resolves, so the UI can tell "no rooms yet"
   *  apart from "haven't asked yet" — they look identical and mean opposite
   *  things. */
  loaded = $state(false)
  error = $state('')

  /** Rooms in a space (all rooms when spaceId is empty). */
  inSpace(spaceId: string): Room[] {
    return this.rooms.filter((r) => !spaceId || r.spaceId === spaceId)
  }

  find(id: string): Room | undefined {
    return this.rooms.find((r) => r.id === id)
  }

  /** Whether this member is in any room at all. */
  get isEmpty(): boolean {
    return this.loaded && this.rooms.length === 0
  }

  async refresh() {
    const me = identity.current
    if (!me) {
      this.rooms = []
      this.spaces = []
      this.loaded = true
      return
    }
    try {
      const res = await cairn.listRooms({ memberPub: me.memberPub })
      this.rooms = res.rooms.map((r) => ({
        id: dec.decode(r.roomId),
        name: r.name,
        kind: 'room' as RoomKind,
        spaceId: dec.decode(r.spaceId),
        createdAt: Number(r.createdAt),
        joined: r.joined,
        visibility: r.visibility || 'discoverable',
      }))
      this.spaces = res.spaces.map((s) => ({
        id: dec.decode(s.spaceId),
        name: s.name,
        label: glyphFor(s.name),
      }))
      this.error = ''
    } catch (e) {
      // Offline: keep whatever we last knew rather than blanking the sidebar,
      // but say so — an empty list and an unreachable server must not look alike.
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.loaded = true
    }
  }

  clear() {
    this.rooms = []
    this.spaces = []
    this.loaded = false
    this.error = ''
  }
}

export const roomStore = new RoomStore()

/**
 * The space id for a household — derived from its root pubkey so EVERY member
 * computes the same value.
 *
 * Previously the id came from the creating member's display name, which meant a
 * second member creating a room founded a second space inside one household.
 * A space is a property of the household, not of whoever got there first.
 */
export function householdSpaceId(householdPub: Uint8Array): string {
  return 'hh-' + hex(householdPub).slice(0, 16)
}

/** Room ids are UTF-8 strings on the wire; keep them URL/­display safe. */
export function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  // Suffix keeps two households (or two rooms of the same name) from colliding
  // on a shared carrier; room ids are global, names are not.
  const rand = hex(crypto.getRandomValues(new Uint8Array(4)))
  return `${base || 'room'}-${rand}`
}

export { utf8 }

// Phase 0 client-side room directory. The CairnService has no ListRooms yet
// (rooms are a client concept until Phase 1 wires space_create/member_add), so
// the shell shows a small fixed set. Room ids are UTF-8 strings for now.

export type RoomKind = 'room' | 'dm' | 'agent'

export interface RoomDef {
  id: string
  name: string
  kind: RoomKind
  sub?: string
}

export interface SpaceDef {
  id: string
  label: string // 1–2 char rail glyph
  name: string
  rooms: RoomDef[]
}

export const SPACES: SpaceDef[] = [
  {
    id: 'home',
    label: 'H',
    name: 'Household',
    rooms: [
      { id: 'general', name: 'general', kind: 'room', sub: 'the whole household' },
      { id: 'field-ops', name: 'field-ops', kind: 'room', sub: 'off-grid coordination' },
      { id: 'atlas', name: 'atlas', kind: 'agent', sub: 'household agent' },
      { id: 'dm-sam', name: 'Sam', kind: 'dm', sub: 'direct message' },
    ],
  },
]

export function roomGlyph(kind: RoomKind): { icon: string; agent?: boolean; dm?: boolean } {
  switch (kind) {
    case 'agent':
      return { icon: 'spark', agent: true }
    case 'dm':
      return { icon: 'person', dm: true }
    default:
      return { icon: 'hash' }
  }
}

export function findRoom(id: string): RoomDef | undefined {
  for (const s of SPACES) {
    const r = s.rooms.find((r) => r.id === id)
    if (r) return r
  }
  return undefined
}

// Local DAG cache in IndexedDB: events persist as they arrive so a reload (or an
// offline start) renders history instantly, before the network Sync reconciles.
// The DAG is the truth and dedups by event_id, so a stale cache is never wrong —
// just possibly behind. Events are stored as their protobuf wire bytes.

import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { EventSchema, type Event } from '../gen/cairn_pb'

const DB_NAME = 'cairn'
const STORE = 'events'
const VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('room', 'room', { unique: false })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

interface Row {
  id: string // event_id hex
  room: string
  bytes: Uint8Array
}

/** Persist an event to the cache (fire-and-forget; failures are non-fatal). */
export async function cachePut(idHex: string, roomIdStr: string, ev: Event): Promise<void> {
  try {
    const conn = await db()
    await new Promise<void>((resolve, reject) => {
      const tx = conn.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ id: idHex, room: roomIdStr, bytes: toBinary(EventSchema, ev) } satisfies Row)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // cache is best-effort; ignore
  }
}

/** Load all cached events for a room, decoded. */
export async function cacheLoad(roomIdStr: string): Promise<Event[]> {
  try {
    const conn = await db()
    return await new Promise<Event[]>((resolve, reject) => {
      const tx = conn.transaction(STORE, 'readonly')
      const idx = tx.objectStore(STORE).index('room')
      const req = idx.getAll(roomIdStr)
      req.onsuccess = () => resolve((req.result as Row[]).map((r) => fromBinary(EventSchema, r.bytes)))
      req.onerror = () => reject(req.error)
    })
  } catch {
    return []
  }
}

// Client-side Cairn crypto: the session signing key, per-room AES keys, and the
// build/open/verify of events — producing event_ids byte-identical to the Go
// server (same canonical CBOR + BLAKE3 + Ed25519).
//
// Dev-phase key handling (Phase 1):
//   - Session key: a per-TAB Ed25519 key in sessionStorage, so two tabs are two
//     distinct participants. Persistent device identity + delegation is Phase 4.
//   - Room key: a per-room AES-256 key in localStorage (shared across same-origin
//     tabs, so both decrypt). Cross-browser key handoff (member_add / HPKE) is a
//     later Phase 1 step; for now a room key can be exported/imported as a link.

import { blake3 } from '@noble/hashes/blake3.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { create } from '@bufbuild/protobuf'
import { encode as cborEncode, decode as cborDecode, type CborValue } from './cbor'
import { EventSchema, EventType, type Event } from '../gen/cairn_pb'

// ---- byte utils ----

export function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function bytesToB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
// WebCrypto's BufferSource wants ArrayBuffer-backed views; our Uint8Arrays are,
// but TS types them as ArrayBufferLike. Narrow at the call boundary.
function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource
}

// uvarint (LEB128 unsigned) — matches Go encoding/binary.Uvarint.
function putUvarint(n: number): Uint8Array {
  const out: number[] = []
  let x = n >>> 0
  while (x >= 0x80) {
    out.push((x & 0x7f) | 0x80)
    x >>>= 7
  }
  out.push(x)
  return new Uint8Array(out)
}
function readUvarint(buf: Uint8Array): { value: number; rest: Uint8Array } {
  let x = 0
  let shift = 0
  let i = 0
  for (;;) {
    const b = buf[i++]
    x |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return { value: x >>> 0, rest: buf.subarray(i) }
}

// ---- AAD (must match room.AAD in Go) ----
// sender_pub || room_id || ts(le64) || uint16(type, le)
function buildAAD(senderPub: Uint8Array, roomId: Uint8Array, ts: bigint, type: number): Uint8Array {
  const ts8 = new Uint8Array(8)
  new DataView(ts8.buffer).setBigUint64(0, BigInt.asUintN(64, ts), true)
  const t2 = new Uint8Array(2)
  new DataView(t2.buffer).setUint16(0, type & 0xffff, true)
  return concat(senderPub, roomId, ts8, t2)
}

// ---- canonical content + id ----
function contentTuple(
  senderPub: Uint8Array,
  roomId: Uint8Array,
  ts: bigint,
  parents: Uint8Array[],
  type: number,
  payload: Uint8Array,
): Uint8Array {
  const sorted = [...parents].sort(cmpBytes)
  return cborEncode([senderPub, roomId, ts, sorted, type, payload])
}

function computeId(
  senderPub: Uint8Array,
  roomId: Uint8Array,
  ts: bigint,
  parents: Uint8Array[],
  type: number,
  payload: Uint8Array,
): Uint8Array {
  return blake3(contentTuple(senderPub, roomId, ts, parents, type, payload))
}

// ---- session key (per tab) ----
const SK_KEY = 'cairn-session-sk'

function sessionSecret(): Uint8Array {
  const stored = sessionStorage.getItem(SK_KEY)
  if (stored) return b64ToBytes(stored)
  const utils = ed25519.utils as { randomSecretKey?: () => Uint8Array; randomPrivateKey?: () => Uint8Array }
  const sk = (utils.randomSecretKey ?? utils.randomPrivateKey)!()
  sessionStorage.setItem(SK_KEY, bytesToB64(sk))
  return sk
}

export function sessionPub(): Uint8Array {
  return ed25519.getPublicKey(sessionSecret())
}

// ---- room key (per room, shared across tabs) ----
const cryptoKeyCache = new Map<string, Promise<CryptoKey>>()

function roomKeyStorageId(roomIdStr: string): string {
  return 'cairn-rk:' + roomIdStr
}

function rawRoomKey(roomIdStr: string): Uint8Array {
  const id = roomKeyStorageId(roomIdStr)
  const stored = localStorage.getItem(id)
  if (stored) return b64ToBytes(stored)
  const raw = crypto.getRandomValues(new Uint8Array(32))
  localStorage.setItem(id, bytesToB64(raw))
  return raw
}

function roomCryptoKey(roomIdStr: string): Promise<CryptoKey> {
  let p = cryptoKeyCache.get(roomIdStr)
  if (!p) {
    p = crypto.subtle.importKey('raw', bs(rawRoomKey(roomIdStr)), { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ])
    cryptoKeyCache.set(roomIdStr, p)
  }
  return p
}

/** Export the current room key as a shareable link fragment (dev key handoff). */
export function roomKeyLink(roomIdStr: string): string {
  const raw = rawRoomKey(roomIdStr)
  return `${location.origin}${import.meta.env.BASE_URL}#rk=${roomIdStr}:${bytesToB64(raw)}`
}

/** Import a room key from a #rk=room:base64 fragment, if present. */
export function importRoomKeyFromHash() {
  const m = location.hash.match(/#rk=([^:]+):(.+)$/)
  if (!m) return
  localStorage.setItem(roomKeyStorageId(decodeURIComponent(m[1])), m[2])
  cryptoKeyCache.delete(decodeURIComponent(m[1]))
  history.replaceState(null, '', location.pathname + location.search)
}

// ---- build / open / verify ----

export interface ChatBody {
  text: string
  replyTo?: Uint8Array
}

/** Build a signed, room-encrypted CHAT event. parents should be the local heads. */
export async function buildChat(
  roomIdStr: string,
  body: ChatBody,
  parents: Uint8Array[],
): Promise<Event> {
  const senderPub = sessionPub()
  const roomId = utf8(roomIdStr)
  const ts = BigInt(Date.now())
  const type = EventType.CHAT

  const plaintext = cborEncode(prune({ text: body.text, reply_to: body.replyTo }))
  const payload = await seal(roomIdStr, senderPub, roomId, ts, type, plaintext)

  const sorted = [...parents].sort(cmpBytes)
  const eventId = computeId(senderPub, roomId, ts, sorted, type, payload)
  const sig = ed25519.sign(eventId, sessionSecret())

  return create(EventSchema, {
    eventId,
    senderPub,
    roomId,
    ts,
    parents: sorted,
    type,
    payload,
    sig,
  })
}

/** Decrypt a CHAT event's body, or null if it isn't a decryptable chat. */
export async function openChat(ev: Event): Promise<ChatBody | null> {
  if (ev.type !== EventType.CHAT) return null
  try {
    const pt = await open(ev)
    const obj = cborDecode(pt) as { text?: string; reply_to?: Uint8Array }
    if (typeof obj.text !== 'string') return null
    return { text: obj.text, replyTo: obj.reply_to }
  } catch {
    return null
  }
}

/** Structural + signature integrity check (mirrors Go event.Verify). */
export function verifyEvent(ev: Event): boolean {
  const id = computeId(ev.senderPub, ev.roomId, ev.ts, ev.parents, ev.type, ev.payload)
  if (!eqBytes(id, ev.eventId)) return false
  try {
    return ed25519.verify(ev.sig, ev.eventId, ev.senderPub)
  } catch {
    return false
  }
}

async function seal(
  roomIdStr: string,
  senderPub: Uint8Array,
  roomId: Uint8Array,
  ts: bigint,
  type: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await roomCryptoKey(roomIdStr)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const aad = buildAAD(senderPub, roomId, ts, type)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bs(nonce), additionalData: bs(aad) },
      key,
      bs(plaintext),
    ),
  )
  return concat(putUvarint(1), nonce, ct)
}

async function open(ev: Event): Promise<Uint8Array> {
  const roomIdStr = new TextDecoder().decode(ev.roomId)
  const key = await roomCryptoKey(roomIdStr)
  const { value: epoch, rest } = readUvarint(ev.payload)
  if (epoch === 0) throw new Error('not room-encrypted')
  const nonce = rest.subarray(0, 12)
  const ct = rest.subarray(12)
  const aad = buildAAD(ev.senderPub, ev.roomId, ev.ts, ev.type)
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(nonce), additionalData: bs(aad) },
      key,
      bs(ct),
    ),
  )
}

// Drop undefined fields so the CBOR map omits them (matches Go omitempty).
function prune(o: Record<string, CborValue | undefined>): { [k: string]: CborValue } {
  const out: { [k: string]: CborValue } = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out
}

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
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm } from '@hpke/core'
import { encode as cborEncode, decode as cborDecode, type CborValue } from './cbor'
import type { InlayInstance } from './inlay/types'
import type { FileRef } from './files'
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
// hpke-js KEM importKey/enc want a real ArrayBuffer, not a view — copy out.
function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
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

/** Sign arbitrary bytes with the session key. Used for portable approval
 *  artifacts, which are signed over their own canonical bytes rather than an
 *  event envelope — so they verify outside Cairn. */
export function signWithSession(msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, sessionSecret())
}

/** The session key as a Signer (for approval artifacts). At Phase 5 this becomes
 *  a passkey ceremony — same shape, biometric gesture behind it. */
export function sessionSigner(): { pub: Uint8Array; sign: (m: Uint8Array) => Uint8Array } {
  return { pub: sessionPub(), sign: signWithSession }
}

// ---- room keys (per room, per epoch) ----
// Each room has a room key per epoch (PROTOCOL.md §5). Membership changes
// (member_add / room_key_rotate) mint a new epoch and HPKE-wrap the fresh key to
// each member. Pre-join history stays opaque: a member only holds the epochs they
// were given. Keys live in localStorage (shared across same-origin tabs).
const cryptoKeyCache = new Map<string, Promise<CryptoKey>>() // `${room}:${epoch}`

const rkId = (room: string, epoch: number) => `cairn-rk:${room}:${epoch}`
const epochId = (room: string) => `cairn-epoch:${room}`

export function currentEpoch(room: string): number {
  return Number(localStorage.getItem(epochId(room)) ?? '1')
}
function setEpoch(room: string, epoch: number) {
  if (epoch > currentEpoch(room)) localStorage.setItem(epochId(room), String(epoch))
}

function rawRoomKey(room: string, epoch: number): Uint8Array | null {
  const s = localStorage.getItem(rkId(room, epoch))
  return s ? b64ToBytes(s) : null
}
function storeRoomKey(room: string, epoch: number, raw: Uint8Array) {
  localStorage.setItem(rkId(room, epoch), bytesToB64(raw))
  cryptoKeyCache.delete(`${room}:${epoch}`)
}

// The room key for the current epoch, bootstrapping epoch 1 on first use so a
// brand-new room is immediately usable (real membership arrives via member_add).
function ensureCurrentKey(room: string): { epoch: number; raw: Uint8Array } {
  const epoch = currentEpoch(room)
  let raw = rawRoomKey(room, epoch)
  if (!raw) {
    raw = crypto.getRandomValues(new Uint8Array(32))
    storeRoomKey(room, epoch, raw)
  }
  return { epoch, raw }
}

function roomCryptoKey(room: string, epoch: number): Promise<CryptoKey> | null {
  const raw = rawRoomKey(room, epoch)
  if (!raw) return null
  const k = `${room}:${epoch}`
  let p = cryptoKeyCache.get(k)
  if (!p) {
    p = crypto.subtle.importKey('raw', bs(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    cryptoKeyCache.set(k, p)
  }
  return p
}

/** The current-epoch room key bytes — needed to wrap per-file keys (data plane). */
export function roomKeyBytes(room: string): Uint8Array {
  return ensureCurrentKey(room).raw
}

/** Export the current-epoch room key as a shareable link fragment (dev handoff). */
export function roomKeyLink(room: string): string {
  const { epoch, raw } = ensureCurrentKey(room)
  return `${location.origin}${import.meta.env.BASE_URL}#rk=${room}:${epoch}:${bytesToB64(raw)}`
}

/** Import a room key from a #rk=room:epoch:base64 fragment, if present. */
export function importRoomKeyFromHash() {
  const m = location.hash.match(/#rk=([^:]+):(\d+):(.+)$/)
  if (!m) return
  const room = decodeURIComponent(m[1])
  const epoch = Number(m[2])
  storeRoomKey(room, epoch, b64ToBytes(m[3]))
  setEpoch(room, epoch)
  history.replaceState(null, '', location.pathname + location.search)
}

// ---- build / open / verify ----

export interface QuoteSnapshot {
  text: string
  author: Uint8Array
  sourceEvent: Uint8Array
  ts: number
}

export interface ChatBody {
  text: string
  replyTo?: Uint8Array
  quote?: QuoteSnapshot
}

// sealAndSign is the shared build path for every event type: encode the payload
// map, room-encrypt it, hash the canonical content, and sign.
function sealAndSign(
  roomIdStr: string,
  type: number,
  payloadMap: { [k: string]: CborValue },
  parents: Uint8Array[],
): Promise<Event> {
  return sealAndSignRaw(roomIdStr, type, cborEncode(payloadMap), parents)
}

// sealAndSignRaw takes already-encoded plaintext (e.g. a pre-signed portable
// approval artifact, which must not be re-encoded or its signature breaks).
async function sealAndSignRaw(
  roomIdStr: string,
  type: number,
  plaintext: Uint8Array,
  parents: Uint8Array[],
): Promise<Event> {
  const senderPub = sessionPub()
  const roomId = utf8(roomIdStr)
  const ts = BigInt(Date.now())

  const payload = await seal(roomIdStr, senderPub, roomId, ts, type, plaintext)

  const sorted = [...parents].sort(cmpBytes)
  const eventId = computeId(senderPub, roomId, ts, sorted, type, payload)
  const sig = ed25519.sign(eventId, sessionSecret())

  return create(EventSchema, { eventId, senderPub, roomId, ts, parents: sorted, type, payload, sig })
}

/** Build a signed, room-encrypted CHAT event. parents should be the local heads. */
export function buildChat(roomIdStr: string, body: ChatBody, parents: Uint8Array[]): Promise<Event> {
  const quote = body.quote
    ? { text: body.quote.text, author: body.quote.author, source_event: body.quote.sourceEvent, ts: BigInt(body.quote.ts) }
    : undefined
  return sealAndSign(
    roomIdStr,
    EventType.CHAT,
    prune({ text: body.text, reply_to: body.replyTo, quote }),
    parents,
  )
}

/** Emit ephemeral presence (online/away). Not part of the DAG (parents empty);
 *  the server broadcasts it without persisting. */
export function buildPresence(roomIdStr: string, state: 'online' | 'away'): Promise<Event> {
  return sealAndSign(roomIdStr, EventType.PRESENCE, { state }, [])
}

/** Post a file_ref: the tiny envelope rides chat, the bytes ride the data plane.
 *  Mesh never carries the bytes — only this. */
export function buildFileRef(
  roomIdStr: string,
  ref: FileRef,
  caption: string,
  parents: Uint8Array[],
): Promise<Event> {
  const file: { [k: string]: CborValue } = {
    hash: ref.hash,
    wrapped_key: ref.wrapped_key,
    mime: ref.mime,
    size: ref.size,
  }
  if (ref.name) file.name = ref.name
  return sealAndSign(roomIdStr, EventType.FILE_REF, prune({ file, caption: caption || undefined }), parents)
}

/** Post a declared inlay: a decl_cid + bindings + the MANDATORY text fallback. */
export function buildInlay(
  roomIdStr: string,
  instance: { decl_cid: string; surface?: string; bindings?: unknown; text: string },
  parents: Uint8Array[],
): Promise<Event> {
  return sealAndSign(
    roomIdStr,
    EventType.INLAY,
    prune({
      decl_cid: instance.decl_cid,
      surface: instance.surface ?? 'timeline',
      bindings: instance.bindings as CborValue,
      text: instance.text,
    }),
    parents,
  )
}

/** Carry a pre-signed portable approval artifact as an event payload. The room
 *  encrypts it for DELIVERY; the artifact's own signature is what the external
 *  broker verifies, so it survives leaving the room. */
export function buildApprovalEvent(
  roomIdStr: string,
  type: number,
  artifactCbor: Uint8Array,
  parents: Uint8Array[],
): Promise<Event> {
  return sealAndSignRaw(roomIdStr, type, artifactCbor, parents)
}

/** REACTION carries the sender's COMPLETE current emoji set for a target (CRDT). */
export function buildReaction(
  roomIdStr: string,
  target: Uint8Array,
  emoji: string[],
  parents: Uint8Array[],
): Promise<Event> {
  return sealAndSign(roomIdStr, EventType.REACTION, { target, emoji }, parents)
}

/** EDIT supersedes the author's own message text. */
export function buildEdit(
  roomIdStr: string,
  target: Uint8Array,
  text: string,
  parents: Uint8Array[],
): Promise<Event> {
  return sealAndSign(roomIdStr, EventType.EDIT, { target, text }, parents)
}

/** DELETE withdraws a message (renders as a tombstone; not cryptographic erasure). */
export function buildDelete(
  roomIdStr: string,
  target: Uint8Array,
  by: 'author' | 'admin',
  parents: Uint8Array[],
): Promise<Event> {
  return sealAndSign(roomIdStr, EventType.DELETE, { target, by }, parents)
}

// Decoded payloads, discriminated by event type.
export type Decoded =
  | { kind: 'chat'; text: string; replyTo?: Uint8Array; quote?: QuoteSnapshot }
  | { kind: 'reaction'; target: Uint8Array; emoji: string[] }
  | { kind: 'edit'; target: Uint8Array; text: string }
  | { kind: 'delete'; target: Uint8Array; by: string }
  | { kind: 'presence'; state: string }
  | { kind: 'inlay'; instance: InlayInstance }
  | { kind: 'file'; ref: FileRef; caption?: string }
  | { kind: 'system'; text: string }
  // Approval artifacts travel as raw CBOR payloads; the caller decodes them via
  // the approval module (kept out of here to avoid a circular import).
  | { kind: 'approval_request'; raw: Uint8Array }
  | { kind: 'approval_grant'; raw: Uint8Array }
  | { kind: 'approval_deny'; raw: Uint8Array }
  | { kind: 'credential_minted'; raw: Uint8Array }
  | { kind: 'other' }

/** Decrypt + decode any supported event payload, or null if undecryptable. */
export async function openEvent(ev: Event): Promise<Decoded | null> {
  // Key-material events are cleartext (epoch 0) — decode without a room key.
  if (ev.type === EventType.MEMBER_ADD || ev.type === EventType.ROOM_KEY_ROTATE) {
    try {
      cborDecode(readUvarint(ev.payload).rest)
      return { kind: 'system', text: ev.type === EventType.MEMBER_ADD ? 'added a member' : 'rotated the room key' }
    } catch {
      return { kind: 'other' }
    }
  }
  try {
    const pt = await open(ev)

    // Approval artifacts are self-signed portable CBOR — hand back the exact
    // bytes so the artifact signature stays intact for the external broker.
    switch (ev.type) {
      case EventType.APPROVAL_REQUEST:
        return { kind: 'approval_request', raw: pt }
      case EventType.APPROVAL_GRANT:
        return { kind: 'approval_grant', raw: pt }
      case EventType.APPROVAL_DENY:
        return { kind: 'approval_deny', raw: pt }
      case EventType.CREDENTIAL_MINTED:
        return { kind: 'credential_minted', raw: pt }
    }

    const obj = cborDecode(pt) as Record<string, unknown>
    switch (ev.type) {
      case EventType.CHAT: {
        if (typeof obj.text !== 'string') return null
        let quote: QuoteSnapshot | undefined
        const q = obj.quote as Record<string, unknown> | undefined
        if (q && typeof q.text === 'string') {
          quote = {
            text: q.text,
            author: q.author as Uint8Array,
            sourceEvent: q.source_event as Uint8Array,
            ts: Number(q.ts ?? 0),
          }
        }
        return { kind: 'chat', text: obj.text, replyTo: obj.reply_to as Uint8Array | undefined, quote }
      }
      case EventType.PRESENCE:
        return { kind: 'presence', state: String(obj.state ?? 'online') }
      case EventType.FILE_REF: {
        const f = obj.file as Record<string, unknown> | undefined
        if (!f?.hash || !f?.wrapped_key) return null
        return {
          kind: 'file',
          ref: {
            hash: f.hash as Uint8Array,
            wrapped_key: f.wrapped_key as Uint8Array,
            mime: String(f.mime ?? 'application/octet-stream'),
            size: Number(f.size ?? 0),
            name: f.name as string | undefined,
          },
          caption: obj.caption as string | undefined,
        }
      }
      case EventType.INLAY:
        // text is mandatory — without it there is nothing to degrade to.
        return typeof obj.text === 'string'
          ? {
              kind: 'inlay',
              instance: {
                decl_cid: String(obj.decl_cid ?? ''),
                surface: obj.surface === 'room_panel' ? 'room_panel' : 'timeline',
                bindings: obj.bindings as Record<string, unknown> | undefined,
                text: obj.text,
              },
            }
          : null
      case EventType.REACTION:
        return { kind: 'reaction', target: obj.target as Uint8Array, emoji: (obj.emoji as string[]) ?? [] }
      case EventType.EDIT:
        return typeof obj.text === 'string'
          ? { kind: 'edit', target: obj.target as Uint8Array, text: obj.text }
          : null
      case EventType.DELETE:
        return { kind: 'delete', target: obj.target as Uint8Array, by: String(obj.by ?? 'author') }
      default:
        return { kind: 'other' }
    }
  } catch {
    return null
  }
}

/** Decrypt a CHAT event's body, or null if it isn't a decryptable chat. */
export async function openChat(ev: Event): Promise<ChatBody | null> {
  const d = await openEvent(ev)
  return d?.kind === 'chat' ? { text: d.text, replyTo: d.replyTo } : null
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
  const { epoch } = ensureCurrentKey(roomIdStr)
  const key = await roomCryptoKey(roomIdStr, epoch)!
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const aad = buildAAD(senderPub, roomId, ts, type)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bs(nonce), additionalData: bs(aad) },
      key,
      bs(plaintext),
    ),
  )
  return concat(putUvarint(epoch), nonce, ct)
}

async function open(ev: Event): Promise<Uint8Array> {
  const roomIdStr = new TextDecoder().decode(ev.roomId)
  const { value: epoch, rest } = readUvarint(ev.payload)
  if (epoch === 0) throw new Error('not room-encrypted')
  const keyP = roomCryptoKey(roomIdStr, epoch)
  if (!keyP) throw new Error(`no room key for epoch ${epoch}`) // pre-join / not yet handed
  const key = await keyP
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

// ---- HPKE room-key wrap/unwrap (member_add / room_key_rotate) ----
// Suite + framing must match Go room/hpke.go: DHKEM(X25519,HKDF-SHA256)/
// HKDF-SHA256/AES-256-GCM, info "cairn/room-key/v1", blob = uvarint(len enc)||enc||ct.
// The recipient is addressed by its Ed25519 pubkey, converted to X25519.

const HPKE_INFO = new TextEncoder().encode('cairn/room-key/v1')
const hpke = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

function hexStr(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

async function wrapKeyTo(recipientEdPub: Uint8Array, roomKey: Uint8Array): Promise<Uint8Array> {
  const xPub = ed25519.utils.toMontgomery(recipientEdPub)
  const rpk = await hpke.kem.importKey('raw', ab(xPub), true)
  const sender = await hpke.createSenderContext({ recipientPublicKey: rpk, info: bs(HPKE_INFO) })
  const ct = new Uint8Array(await sender.seal(bs(roomKey)))
  const enc = new Uint8Array(sender.enc)
  return concat(putUvarint(enc.length), enc, ct)
}

async function unwrapKey(blob: Uint8Array): Promise<Uint8Array> {
  const { value: encLen, rest } = readUvarint(blob)
  const enc = rest.subarray(0, encLen)
  const ct = rest.subarray(encLen)
  const xPriv = ed25519.utils.toMontgomerySecret(sessionSecret())
  const rsk = await hpke.kem.importKey('raw', ab(xPriv), false)
  const recip = await hpke.createRecipientContext({ recipientKey: rsk, enc: ab(enc), info: bs(HPKE_INFO) })
  return new Uint8Array(await recip.open(bs(ct)))
}

// buildCleartext builds a signed epoch-0 (unencrypted) event — used for the
// key-material events whose payloads carry their own HPKE-wrapped keys.
async function buildCleartext(
  roomIdStr: string,
  type: number,
  payloadMap: { [k: string]: CborValue },
  parents: Uint8Array[],
): Promise<Event> {
  const senderPub = sessionPub()
  const roomId = utf8(roomIdStr)
  const ts = BigInt(Date.now())
  const payload = concat(putUvarint(0), cborEncode(payloadMap)) // uvarint(0) || cbor
  const sorted = [...parents].sort(cmpBytes)
  const eventId = computeId(senderPub, roomId, ts, sorted, type, payload)
  const sig = ed25519.sign(eventId, sessionSecret())
  return create(EventSchema, { eventId, senderPub, roomId, ts, parents: sorted, type, payload, sig })
}

function dedupePubs(pubs: Uint8Array[]): Uint8Array[] {
  const seen = new Set<string>()
  const out: Uint8Array[] = []
  for (const p of pubs) {
    const h = hexStr(p)
    if (!seen.has(h)) {
      seen.add(h)
      out.push(p)
    }
  }
  return out
}

// mints a fresh epoch key, wraps it to every recipient, and stores it locally.
async function mintEpoch(
  roomIdStr: string,
  recipients: Uint8Array[],
): Promise<{ epoch: number; wrapped_keys: { [hex: string]: Uint8Array } }> {
  const newKey = crypto.getRandomValues(new Uint8Array(32))
  const epoch = currentEpoch(roomIdStr) + 1
  const wrapped_keys: { [hex: string]: Uint8Array } = {}
  for (const pub of dedupePubs([...recipients, sessionPub()])) {
    wrapped_keys[hexStr(pub)] = await wrapKeyTo(pub, newKey)
  }
  storeRoomKey(roomIdStr, epoch, newKey)
  setEpoch(roomIdStr, epoch)
  return { epoch, wrapped_keys }
}

/** Add a member: mint a new epoch, wrap it to everyone, emit member_add. */
export async function buildMemberAdd(
  roomIdStr: string,
  newMemberPub: Uint8Array,
  role: string,
  existingMemberPubs: Uint8Array[],
  parents: Uint8Array[],
): Promise<Event> {
  const { epoch, wrapped_keys } = await mintEpoch(roomIdStr, [...existingMemberPubs, newMemberPub])
  return buildCleartext(
    roomIdStr,
    EventType.MEMBER_ADD,
    { member_pub: newMemberPub, role, epoch, wrapped_keys },
    parents,
  )
}

/** Rotate the room key for the current membership (e.g. after a removal). */
export async function buildRoomKeyRotate(
  roomIdStr: string,
  memberPubs: Uint8Array[],
  parents: Uint8Array[],
): Promise<Event> {
  const { epoch, wrapped_keys } = await mintEpoch(roomIdStr, memberPubs)
  return buildCleartext(roomIdStr, EventType.ROOM_KEY_ROTATE, { epoch, wrapped_keys }, parents)
}

/** On receiving a member_add/room_key_rotate, unwrap my epoch key if present.
 *  Returns true if a new key was installed (so pending events can re-decrypt). */
export async function applyKeyEvent(ev: Event): Promise<boolean> {
  if (ev.type !== EventType.MEMBER_ADD && ev.type !== EventType.ROOM_KEY_ROTATE) return false
  const room = new TextDecoder().decode(ev.roomId)
  try {
    const obj = cborDecode(readUvarint(ev.payload).rest) as {
      epoch: number
      wrapped_keys: { [hex: string]: Uint8Array }
    }
    const blob = obj.wrapped_keys?.[hexStr(sessionPub())]
    if (!blob) return false // not addressed to me
    if (rawRoomKey(room, obj.epoch)) {
      setEpoch(room, obj.epoch)
      return false // already had it
    }
    storeRoomKey(room, obj.epoch, await unwrapKey(blob))
    setEpoch(room, obj.epoch)
    return true
  } catch {
    return false
  }
}

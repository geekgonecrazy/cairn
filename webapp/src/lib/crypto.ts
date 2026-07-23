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
import { cairn } from './api'
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
// The session key is SCOPED TO THE DEVICE KEY that delegates it. Onboarding (or
// recovery) mints a new device key, which changes this storage slot, so a tab
// that was open before setup stops signing under its pre-identity throwaway key
// instead of silently carrying it forward.
//
// With no identity yet (the pre-onboarding shell) we still mint an unbound key
// so the app renders, but it chains to nothing and is replaced on setup.
const SK_KEY_BASE = 'cairn-session-sk'

function sessionSlot(): string {
  const devicePub = currentDevicePubHex()
  return devicePub ? `${SK_KEY_BASE}:${devicePub.slice(0, 16)}` : SK_KEY_BASE
}

function sessionSecret(): Uint8Array {
  const slot = sessionSlot()
  const stored = sessionStorage.getItem(slot)
  if (stored) return b64ToBytes(stored)
  const utils = ed25519.utils as { randomSecretKey?: () => Uint8Array; randomPrivateKey?: () => Uint8Array }
  const sk = (utils.randomSecretKey ?? utils.randomPrivateKey)!()
  sessionStorage.setItem(slot, bytesToB64(sk))
  return sk
}

/** Device pubkey hex from the vault, or '' when this browser is un-onboarded.
 *  Read straight from storage to keep crypto.ts free of app-state imports. */
function currentDevicePubHex(): string {
  try {
    const sk = localStorage.getItem('cairn-device-sk')
    if (!sk) return ''
    return hexStr(ed25519.getPublicKey(b64ToBytes(sk)))
  } catch {
    return ''
  }
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
// Each room has a room key per epoch (docs/protocol.md §5). Membership changes
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

/** Thrown when a key event that WAS meant for us could not be applied. Distinct
 *  from NoRoomKeyError, which means "we were never given access": this one means
 *  "we were given access and something is wrong", and must not look the same. */
export class KeyEventError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'KeyEventError'
  }
}

/** Thrown when an operation needs a room key we do not hold — i.e. we are not a
 *  member of that room. Callers surface this as an honest "no access" state,
 *  never by minting a key. */
export class NoRoomKeyError extends Error {
  constructor(room: string) {
    super(`no room key for "${room}" — you are not a member of this room`)
    this.name = 'NoRoomKeyError'
  }
}

/**
 * The room key for the current epoch, or null if we hold none.
 *
 * This DELIBERATELY does not mint one. Silently generating a key for any room
 * you happen to open is what let two people sit in the same "room" holding
 * different keys, each believing they were members of something nobody had
 * created. A key arrives exactly two ways: you created the room, or a member
 * wrapped one to you (member_add / room_key_rotate). No key means no membership,
 * and the UI must say so rather than encrypt into the void.
 */
function currentKey(room: string): { epoch: number; raw: Uint8Array } | null {
  const epoch = currentEpoch(room)
  const raw = rawRoomKey(room, epoch)
  return raw ? { epoch, raw } : null
}

/** Mint the first key for a room being created. Only createRoom may call this. */
export function mintInitialRoomKey(room: string): Uint8Array {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  storeRoomKey(room, 1, raw)
  setEpoch(room, 1)
  return raw
}

/** Whether we hold a usable key for this room (i.e. we are really a member). */
export function haveRoomKey(room: string): boolean {
  return currentKey(room) !== null
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
  const k = currentKey(room)
  if (!k) throw new NoRoomKeyError(room)
  return k.raw
}

// REMOVED: the #rk= room-key link (roomKeyLink / importRoomKeyFromHash).
//
// It was a Phase-1 dev shortcut from when rooms were the hardcoded data.ts
// fixture: pasting a link installed a key and you "joined" a room that had
// always been on screen. With real membership the link cannot work — the
// sidebar is driven by signed MEMBER_ADD events, so a key alone leaves you
// with nothing to open, and only an existing member can sign you in.
//
// It was also a soft hazard: any URL could silently plant a room key in your
// browser. Use Members & keys → Add a member by key instead, which mints an
// epoch and records membership in the DAG.

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

/**
 * Publish a declaration into the room so instances can reference it by decl_cid.
 *
 * The cid is NOT carried: it is BLAKE3 over the declaration's deterministic
 * CBOR, so every receiver derives it from the bytes it actually got. Sending it
 * would only create a field that can disagree with its own content.
 */
export function buildInlayDecl(
  roomIdStr: string,
  decl: unknown,
  parents: Uint8Array[],
): Promise<Event> {
  return sealAndSign(roomIdStr, EventType.INLAY_DECL, { decl: decl as CborValue }, parents)
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

/**
 * Check point a posted inlay: a bindings-shaped `state` for an existing instance.
 *
 * The update carries only what changed, not a whole new instance, so a long-lived
 * inlay (a progress bar, a task status) costs one small event per tick instead of
 * re-posting its declaration reference and text fallback every time.
 */
export function buildInlayUpdate(
  roomIdStr: string,
  target: Uint8Array,
  state: unknown,
  parents: Uint8Array[],
): Promise<Event> {
  return sealAndSign(roomIdStr, EventType.INLAY_UPDATE, { target, state: state as CborValue }, parents)
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
  | { kind: 'inlay_decl'; decl: Record<string, unknown> }
  | { kind: 'inlay_update'; target: Uint8Array; state: Record<string, unknown> }
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
  // A join request rides the room DAG in cleartext (the requester holds no key).
  // Render it as a system line; the actionable surface is the pending-request
  // list folded separately, not this row.
  if (ev.type === EventType.ROOM_JOIN_REQUEST) {
    return { kind: 'system', text: 'asked to join' }
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
      case EventType.INLAY_DECL:
        return obj.decl && typeof obj.decl === 'object'
          ? { kind: 'inlay_decl', decl: obj.decl as Record<string, unknown> }
          : null
      case EventType.INLAY_UPDATE:
        // Without a target there is no instance to fold into, and a non-map
        // state could not merge into bindings — either way the checkpoint is
        // unusable rather than merely empty.
        return obj.target && obj.state && typeof obj.state === 'object'
          ? { kind: 'inlay_update', target: obj.target as Uint8Array, state: obj.state as Record<string, unknown> }
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
  const k = currentKey(roomIdStr)
  if (!k) throw new NoRoomKeyError(roomIdStr)
  const key = await roomCryptoKey(roomIdStr, k.epoch)!
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const aad = buildAAD(senderPub, roomId, ts, type)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bs(nonce), additionalData: bs(aad) },
      key,
      bs(plaintext),
    ),
  )
  return concat(putUvarint(k.epoch), nonce, ct)
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

/** This DEVICE's keypair from the vault, read straight from storage to keep
 *  crypto.ts free of app-state imports. Null when un-onboarded.
 *
 *  Room keys wrap to device keys, so this — not the member root — is the unwrap
 *  identity. The member root is offline (it lives only in the member's recovery
 *  words) and is deliberately absent from storage entirely. */
function deviceIdentity(): { devicePub: Uint8Array; devicePriv: Uint8Array } | null {
  try {
    const sk = localStorage.getItem('cairn-device-sk')
    if (!sk) return null
    const devicePriv = b64ToBytes(sk)
    return { devicePriv, devicePub: ed25519.getPublicKey(devicePriv) }
  } catch {
    return null
  }
}

/** Our member ROOT pubkey (public only — the secret never touches this device).
 *  Membership is still recorded per member; only decryption is per device. */
function myMemberPub(): Uint8Array | null {
  try {
    const pub = localStorage.getItem('cairn-member-pub')
    return pub ? b64ToBytes(pub) : null
  } catch {
    return null
  }
}

async function unwrapKey(blob: Uint8Array): Promise<Uint8Array> {
  const { value: encLen, rest } = readUvarint(blob)
  const enc = rest.subarray(0, encLen)
  const ct = rest.subarray(encLen)
  const me = deviceIdentity()
  if (!me) throw new Error('no device identity to unwrap a room key with')
  const xPriv = ed25519.utils.toMontgomerySecret(me.devicePriv)
  const rsk = await hpke.kem.importKey('raw', ab(xPriv), false)
  const recip = await hpke.createRecipientContext({ recipientKey: rsk, enc: ab(enc), info: bs(HPKE_INFO) })
  return new Uint8Array(await recip.open(bs(ct)))
}

/**
 * Expand member roots into the DEVICE keys a room key must be sealed to.
 *
 * Room keys wrap to devices, not to the offline member root, so admitting a
 * member means sealing to every device in their tree. Revoked devices — and
 * anything paired from one — are excluded by the carrier, which is what makes a
 * revocation actually cut a device out of the next epoch.
 *
 * Our OWN device is always included, from local state rather than the lookup: a
 * key we cannot ourselves unwrap is a key we have just lost.
 */
async function devicesForMembers(memberPubs: Uint8Array[]): Promise<Uint8Array[]> {
  const me = deviceIdentity()
  if (!me) throw new Error('cannot wrap a room key without a device identity')

  const out: Uint8Array[] = [me.devicePub]
  for (const memberPub of dedupePubs(memberPubs)) {
    const res = await cairn.listMemberDevices({ memberPub })
    // A member with no published devices yet contributes nothing. That is the
    // honest outcome — we cannot seal to a key we have never seen — and it
    // resolves itself when they publish and someone next rotates.
    out.push(...res.devicePubs)
  }
  return dedupePubs(out)
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

/**
 * Mint a fresh epoch key, wrap it to every recipient's DEVICES, and store it.
 *
 * `memberPubs` are member roots — membership is a member-level fact — but the
 * wrapping is per device, because the member root is offline and holds no
 * secret to unwrap with. Each member is expanded to their non-revoked device
 * tree, which is what makes a revoked device fall out of the next epoch: it is
 * simply no longer in the set, and nothing is sealed to it again.
 *
 * Sealing to a session key would be wrong for the older reason too: a session
 * key dies with the tab, so a member would lose the room on reload.
 */
async function mintEpoch(
  roomIdStr: string,
  memberPubs: Uint8Array[],
): Promise<{ epoch: number; wrapped_keys: { [hex: string]: Uint8Array } }> {
  const newKey = crypto.getRandomValues(new Uint8Array(32))
  const epoch = currentEpoch(roomIdStr) + 1
  const wrapped_keys: { [hex: string]: Uint8Array } = {}
  for (const pub of await devicesForMembers(memberPubs)) {
    wrapped_keys[hexStr(pub)] = await wrapKeyTo(pub, newKey)
  }
  storeRoomKey(roomIdStr, epoch, newKey)
  setEpoch(roomIdStr, epoch)
  return { epoch, wrapped_keys }
}

/**
 * Create a space. Cleartext (epoch 0) because a space_create is the root of a
 * policy boundary — nothing is encrypted under it yet.
 */
export async function buildSpaceCreate(
  spaceIdStr: string,
  name: string,
  parents: Uint8Array[] = [],
): Promise<Event> {
  return buildCleartext(
    spaceIdStr,
    EventType.SPACE_CREATE,
    { space_name: name, admit_kind: 'human,agent', admit_origin: 'own' },
    parents,
  )
}

/**
 * Create a room and mint its first key.
 *
 * ROOM_CREATE is cleartext: a node that is not yet a member must be able to fold
 * it, and there is no key to encrypt under until this call mints one. The
 * creator is NOT implicitly a member — the caller follows this with a
 * member_add naming their own member root, so membership always has a signed
 * event behind it rather than being inferred from authorship.
 */
export async function buildRoomCreate(
  roomIdStr: string,
  name: string,
  spaceIdStr: string,
  visibility: 'discoverable' | 'hidden' = 'discoverable',
  parents: Uint8Array[] = [],
): Promise<Event> {
  mintInitialRoomKey(roomIdStr)
  return buildCleartext(
    roomIdStr,
    EventType.ROOM_CREATE,
    { name, space_id: utf8(spaceIdStr), visibility },
    parents,
  )
}

/**
 * Grant SPACE membership — the discovery tier. Unlike buildMemberAdd this wraps
 * NO key: it only records that a member root belongs to a space, which is what
 * lets them SEE the space's discoverable rooms. The space is named in room_id,
 * exactly as buildSpaceCreate names it.
 */
export async function buildSpaceMemberAdd(
  spaceIdStr: string,
  memberPub: Uint8Array,
  role: string,
  parents: Uint8Array[] = [],
): Promise<Event> {
  return buildCleartext(
    spaceIdStr,
    EventType.SPACE_MEMBER_ADD,
    { member_pub: memberPub, role },
    parents,
  )
}

/**
 * Ask to be admitted to a room you can discover but hold no key for. Carries our
 * own member root so an existing member knows who to wrap the key to; cleartext
 * (epoch 0) because the requester has no room key to encrypt under. It is an
 * ask, not an admission — only a member's MEMBER_ADD actually grants access.
 */
export async function buildRoomJoinRequest(
  roomIdStr: string,
  memberPub: Uint8Array,
  reason: string,
  parents: Uint8Array[] = [],
): Promise<Event> {
  return buildCleartext(
    roomIdStr,
    EventType.ROOM_JOIN_REQUEST,
    { member_pub: memberPub, reason },
    parents,
  )
}

/**
 * Update a space's name and admit policy. Carries the FULL desired state (the
 * settings modal always sends every field), so the fold overwrites rather than
 * merges. Cleartext epoch 0, like space_create.
 */
export async function buildSpaceUpdate(
  spaceIdStr: string,
  name: string,
  admitKind: string,
  admitOrigin: string,
  parents: Uint8Array[] = [],
): Promise<Event> {
  return buildCleartext(
    spaceIdStr,
    EventType.SPACE_UPDATE,
    { space_name: name, admit_kind: admitKind, admit_origin: admitOrigin },
    parents,
  )
}

/** Revoke a member's SPACE membership — drops them from the space roster (their
 *  discovery grant). Wraps no key and does not touch individual room memberships. */
export async function buildSpaceMemberRemove(
  spaceIdStr: string,
  memberPub: Uint8Array,
  parents: Uint8Array[] = [],
): Promise<Event> {
  return buildCleartext(
    spaceIdStr,
    EventType.SPACE_MEMBER_REMOVE,
    { member_pub: memberPub },
    parents,
  )
}

/**
 * Remove a member from a ROOM. Cleartext epoch 0 — it just drops them from the
 * roster. To actually cut off access the caller pairs this with a
 * ROOM_KEY_ROTATE wrapped to the REMAINING members (see state.removeMember), so
 * the removed member holds no key for the new epoch. Pre-removal history they
 * already hold stays readable — keys cannot be un-shared.
 */
export async function buildMemberRemove(
  roomIdStr: string,
  memberPub: Uint8Array,
  parents: Uint8Array[] = [],
): Promise<Event> {
  return buildCleartext(
    roomIdStr,
    EventType.MEMBER_REMOVE,
    { member_pub: memberPub },
    parents,
  )
}

/** Every epoch key we hold for a room, oldest first. */
function heldEpochs(room: string): { epoch: number; raw: Uint8Array }[] {
  const out: { epoch: number; raw: Uint8Array }[] = []
  for (let e = 1; e <= currentEpoch(room); e++) {
    const raw = rawRoomKey(room, e)
    if (raw) out.push({ epoch: e, raw })
  }
  return out
}

/**
 * Add a member: mint a new epoch, wrap it to everyone, emit member_add.
 *
 * shareHistory wraps the OLDER epoch keys we hold to the newcomer as well, so
 * they can read messages sent before they joined. Default false — pre-join
 * opacity is the protocol's stated rule (docs/plan.md Phase 1), and disclosing the
 * backlog must be a deliberate act.
 *
 * IRREVERSIBLE: once an old epoch key is wrapped to someone, they hold it
 * forever. Removing them later does not un-share what they can already decrypt.
 * The `history_shared` flag rides in the signed payload so every member can see
 * that it happened — sharing the backlog silently would be the dishonest version.
 */
export async function buildMemberAdd(
  roomIdStr: string,
  newMemberPub: Uint8Array,
  role: string,
  existingMemberPubs: Uint8Array[],
  parents: Uint8Array[],
  shareHistory = false,
): Promise<Event> {
  const { epoch, wrapped_keys } = await mintEpoch(roomIdStr, [...existingMemberPubs, newMemberPub])

  // Past epochs, wrapped to the newcomer only — existing members already hold
  // them. Nested epoch → device → blob, because the newcomer may have several
  // devices and each needs its own wrap; a single blob per epoch would give the
  // backlog to whichever device happened to be wrapped and silently strand the
  // rest, which reads as "history sharing didn't work" on that device.
  const history_keys: { [epoch: string]: { [deviceHex: string]: Uint8Array } } = {}
  if (shareHistory) {
    const newDevices = await devicesForMembers([newMemberPub])
    for (const { epoch: e, raw } of heldEpochs(roomIdStr)) {
      if (e >= epoch) continue
      const perDevice: { [deviceHex: string]: Uint8Array } = {}
      for (const pub of newDevices) {
        perDevice[hexStr(pub)] = await wrapKeyTo(pub, raw)
      }
      history_keys[String(e)] = perDevice
    }
  }

  return buildCleartext(
    roomIdStr,
    EventType.MEMBER_ADD,
    {
      member_pub: newMemberPub,
      role,
      epoch,
      wrapped_keys,
      history_shared: shareHistory,
      history_keys,
    },
    parents,
  )
}

/**
 * Rotate the room key for the current membership (e.g. after a removal).
 *
 * shareHistory additionally wraps the older epochs we hold to OUR OWN devices,
 * which is what lets a newly paired device read the backlog. Unlike the
 * member_add case this discloses nothing: every one of those keys is already
 * held by the member doing the rotating, and a paired device belongs to that
 * same member root. docs/protocol.md §5 scopes pre-join opacity to new *members*;
 * it says nothing about a member's own devices.
 */
export async function buildRoomKeyRotate(
  roomIdStr: string,
  memberPubs: Uint8Array[],
  parents: Uint8Array[],
  shareHistory = false,
): Promise<Event> {
  const { epoch, wrapped_keys } = await mintEpoch(roomIdStr, memberPubs)

  const payload: {
    epoch: number
    wrapped_keys: { [hex: string]: Uint8Array }
    member_pub?: Uint8Array
    history_shared?: boolean
    history_keys?: { [epoch: string]: { [deviceHex: string]: Uint8Array } }
  } = { epoch, wrapped_keys }

  const memberPub = shareHistory ? myMemberPub() : null
  if (memberPub) {
    // Wrapped to ALL our devices, not just the new one: the wrap is addressed by
    // device, and the roster of which device is "new" is exactly the thing that
    // goes stale. Re-wrapping to every device we know is idempotent — a device
    // that already holds an epoch skips it on apply (see applyKeyEvent).
    const myDevices = await devicesForMembers([memberPub])
    const history_keys: { [epoch: string]: { [deviceHex: string]: Uint8Array } } = {}
    for (const { epoch: e, raw } of heldEpochs(roomIdStr)) {
      if (e >= epoch) continue
      const perDevice: { [deviceHex: string]: Uint8Array } = {}
      for (const pub of myDevices) {
        perDevice[hexStr(pub)] = await wrapKeyTo(pub, raw)
      }
      history_keys[String(e)] = perDevice
    }
    payload.member_pub = memberPub
    payload.history_shared = true
    payload.history_keys = history_keys
  }

  return buildCleartext(roomIdStr, EventType.ROOM_KEY_ROTATE, payload, parents)
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
      member_pub?: Uint8Array
      history_keys?: { [epoch: string]: { [deviceHex: string]: Uint8Array } }
    }
    // Keys are addressed to THIS DEVICE; membership is still recorded against
    // the member root, which is why history_keys is matched on the member and
    // wrapped_keys on the device.
    const me = deviceIdentity()
    const memberPub = myMemberPub()
    if (!me || !memberPub) return false

    // Back-fill any shared history epochs addressed to us. Done before the
    // current-epoch check so a re-delivered member_add still installs them.
    if (obj.member_pub && hexStr(obj.member_pub) === hexStr(memberPub) && obj.history_keys) {
      for (const [epochStr, perDevice] of Object.entries(obj.history_keys)) {
        const e = Number(epochStr)
        if (!Number.isFinite(e) || rawRoomKey(room, e)) continue
        const blob = perDevice?.[hexStr(me.devicePub)]
        if (!blob) continue // shared, but not with this device
        try {
          storeRoomKey(room, e, await unwrapKey(blob))
        } catch {
          /* not wrapped to us, or corrupt — skip rather than fail the whole event */
        }
      }
    }

    const blob = obj.wrapped_keys?.[hexStr(me.devicePub)]
    if (!blob) {
      // Not addressed to this device — and that is NORMAL, not an error. Every
      // key event predating this device names members but not a device that did
      // not exist yet, so a newly paired device replays a pile of them on its
      // first sync. Raising here turned an ordinary backfill into a stream of
      // alarming banners claiming the key had not been shared.
      //
      // Whether we ACTUALLY lack access is a question about the room after all
      // events are folded, not about any single event — see AppState.checkRoomKey.
      return false
    }
    if (rawRoomKey(room, obj.epoch)) {
      setEpoch(room, obj.epoch)
      return false // already had it
    }
    // Addressed to us: from here a failure is REAL, not "someone else's event".
    let raw: Uint8Array
    try {
      raw = await unwrapKey(blob)
    } catch (e) {
      throw new KeyEventError(
        `A room key was addressed to this device but could not be opened. That means the ` +
          `key it was sealed to is not the key this device holds. ` +
          `(device ${hexStr(me.devicePub).slice(0, 12)}…, epoch ${obj.epoch}: ` +
          `${e instanceof Error ? e.message : String(e)})`,
      )
    }
    storeRoomKey(room, obj.epoch, raw)
    setEpoch(room, obj.epoch)
    return true
  } catch (e) {
    // A key event we cannot apply is how a device ends up staring at "you're not
    // a member" of a room it was just given access to. Swallowing every failure
    // here made that indistinguishable from genuinely not being a member.
    if (e instanceof KeyEventError) throw e
    throw new KeyEventError(
      `A room key event could not be processed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

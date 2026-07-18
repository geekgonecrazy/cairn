// Client data plane. Mirrors Go's blobs package exactly:
//   ciphertext  = nonce(12) || AES-256-GCM(fileKey, nonce, plaintext)   [no AAD]
//   hash        = BLAKE3-256(ciphertext)      ← the content address
//   wrapped_key = nonce(12) || AES-256-GCM(roomKey, nonce, fileKey)     [no AAD]
//   envelope    = { hash, wrapped_key, mime, size, name?, thumb_hash? }
//
// The gateway only ever receives ciphertext, so it is zero-knowledge. Chat carries
// the envelope; the bytes ride the data plane separately — and may not be here
// yet, which is a real state, not a spinner.
//
// NOTE: the gateway is backed by a local filesystem store standing in for
// iroh-store (decisions.md §Deviations). Nothing in this file changes when the
// real data plane lands — only where the bytes come from.

import { blake3 } from '@noble/hashes/blake3.js'
import { encode as cborEncode, decode as cborDecode } from './cbor'

export type RetrievalState = 'available' | 'pending' | 'downloading' | 'broken'

export interface FileRef {
  hash: Uint8Array
  wrapped_key: Uint8Array
  mime: string
  size: number
  name?: string
  thumb_hash?: Uint8Array
}

// Same-origin by default (the browser case). Overridable for the native wrapper
// or an out-of-browser harness, where a relative URL has no meaning.
const BASE = (globalThis as { __CAIRN_API__?: string }).__CAIRN_API__ ?? ''

const bs = (u: Uint8Array) => u as unknown as BufferSource
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

async function sealAesGcm(rawKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bs(rawKey), { name: 'AES-GCM' }, false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(nonce) }, key, bs(plaintext)))
  return concat(nonce, ct)
}

async function openAesGcm(rawKey: Uint8Array, framed: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bs(rawKey), { name: 'AES-GCM' }, false, ['decrypt'])
  const nonce = framed.subarray(0, 12)
  const ct = framed.subarray(12)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(nonce) }, key, bs(ct)))
}

/** Encrypt a file, upload the ciphertext, and return the envelope for chat. */
export async function sealFile(
  roomKey: Uint8Array,
  plaintext: Uint8Array,
  mime: string,
  name: string,
): Promise<FileRef> {
  const fileKey = crypto.getRandomValues(new Uint8Array(32))
  const ciphertext = await sealAesGcm(fileKey, plaintext)
  const hash = blake3(ciphertext)

  const res = await fetch(`${BASE}/v1/blob`, { method: 'POST', body: bs(ciphertext) as BodyInit })
  if (!res.ok) throw new Error(`blob upload failed: ${res.status}`)
  const { hash: serverHex } = (await res.json()) as { hash: string }
  if (serverHex !== hexOf(hash)) throw new Error('gateway returned a different content address')

  return {
    hash,
    wrapped_key: await sealAesGcm(roomKey, fileKey),
    mime,
    size: plaintext.length,
    name: name || undefined,
  }
}

/** Fetch + verify + decrypt. Throws 'pending' when the bytes aren't reachable. */
export async function openFile(roomKey: Uint8Array, ref: FileRef): Promise<Uint8Array> {
  const res = await fetch(`${BASE}/v1/blob/${hexOf(ref.hash)}`)
  if (res.status === 404) throw new Error('pending')
  if (!res.ok) throw new Error('pending')
  const ciphertext = new Uint8Array(await res.arrayBuffer())

  // Verify the content address before trusting the bytes.
  if (hexOf(blake3(ciphertext)) !== hexOf(ref.hash)) throw new Error('broken')
  try {
    const fileKey = await openAesGcm(roomKey, ref.wrapped_key)
    return await openAesGcm(fileKey, ciphertext)
  } catch {
    throw new Error('broken')
  }
}

/** Honest availability check without downloading the whole object. */
export async function probeFile(ref: FileRef): Promise<RetrievalState> {
  try {
    const res = await fetch(`${BASE}/v1/blob/${hexOf(ref.hash)}`, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    })
    return res.ok || res.status === 206 ? 'available' : 'pending'
  } catch {
    return 'pending'
  }
}

export function encodeRef(r: FileRef): Uint8Array {
  const m: Record<string, unknown> = {
    hash: r.hash,
    wrapped_key: r.wrapped_key,
    mime: r.mime,
    size: r.size,
  }
  if (r.name) m.name = r.name
  if (r.thumb_hash) m.thumb_hash = r.thumb_hash
  return cborEncode(m as never)
}

export function decodeRef(b: Uint8Array): FileRef | null {
  try {
    const o = cborDecode(b) as Record<string, unknown>
    if (!o.hash || !o.wrapped_key) return null
    return {
      hash: o.hash as Uint8Array,
      wrapped_key: o.wrapped_key as Uint8Array,
      mime: String(o.mime ?? 'application/octet-stream'),
      size: Number(o.size ?? 0),
      name: o.name as string | undefined,
      thumb_hash: o.thumb_hash as Uint8Array | undefined,
    }
  } catch {
    return null
  }
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export const refHex = hexOf

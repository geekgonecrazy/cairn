// Portable capability-approval artifacts, browser side. Mirrors Go's approval
// package byte-for-byte: each artifact is signed over its OWN canonical
// deterministic-CBOR (with `sig` cleared to null, matching Go's nil slice), so
// what you sign here verifies standalone outside Cairn — that is the whole point.
//
// You approve IN THE UI: the Approve button signs with your key right here, the
// signed grant goes back into the room as an event, and the agent picks it up and
// carries it to the capability broker (external) to exchange for a token.

import { blake3 } from '@noble/hashes/blake3.js'
import { encode as cborEncode, decode as cborDecode, type CborValue } from './cbor'

/** Whoever holds the approving key. Kept abstract so this module is pure and
 *  testable outside the browser (and so a passkey signer can slot in at Phase 5). */
export interface Signer {
  pub: Uint8Array
  sign: (msg: Uint8Array) => Uint8Array
}

export interface Capability {
  name: string
  params?: Record<string, string>
  scope?: string
  task_id?: string
}

export interface Request {
  request_id: Uint8Array
  agent_pub: Uint8Array
  capability: Capability
  request_hash: Uint8Array
  issued_at: number
  expires_at: number
  sig: Uint8Array
}

export interface Grant {
  request_id: Uint8Array
  capability_hash: Uint8Array
  agent_pub: Uint8Array
  approver_pub: Uint8Array
  issued_at: number
  expires_at: number
  sig: Uint8Array
}

export interface Deny {
  request_id: Uint8Array
  approver_pub: Uint8Array
  reason?: string
  issued_at: number
  sig: Uint8Array
}

// Go omits empty maps/strings (omitempty) — mirror that so hashes agree.
function capabilityMap(c: Capability): { [k: string]: CborValue } {
  const m: { [k: string]: CborValue } = { name: c.name }
  if (c.params && Object.keys(c.params).length > 0) m.params = c.params as CborValue
  if (c.scope) m.scope = c.scope
  if (c.task_id) m.task_id = c.task_id
  return m
}

/** BLAKE3 over the capability's deterministic CBOR — the binding value. */
export function hashCapability(c: Capability): Uint8Array {
  return blake3(cborEncode(capabilityMap(c)))
}

// Signing bytes: the artifact with `sig` set to null (Go marshals a nil []byte
// as CBOR null, so we must too or the signature won't verify cross-impl).
function grantMap(g: Omit<Grant, 'sig'>, sig: CborValue): { [k: string]: CborValue } {
  return {
    request_id: g.request_id,
    capability_hash: g.capability_hash,
    agent_pub: g.agent_pub,
    approver_pub: g.approver_pub,
    issued_at: g.issued_at,
    expires_at: g.expires_at,
    sig,
  }
}

function denyMap(d: Omit<Deny, 'sig'>, sig: CborValue): { [k: string]: CborValue } {
  const m: { [k: string]: CborValue } = {
    request_id: d.request_id,
    approver_pub: d.approver_pub,
    issued_at: d.issued_at,
    sig,
  }
  if (d.reason) m.reason = d.reason
  return m
}

/** Sign a grant with YOUR key, in-page. This artifact is the deliverable. */
export function signGrant(req: Request, expiresAt: number, signer: Signer): Grant {
  const base = {
    request_id: req.request_id,
    capability_hash: req.request_hash, // bind to exactly what was asked
    agent_pub: req.agent_pub, // bind to exactly who may use it
    approver_pub: signer.pub,
    issued_at: Date.now(),
    expires_at: expiresAt,
  }
  const sig = signer.sign(cborEncode(grantMap(base, null)))
  return { ...base, sig }
}

/** Sign a denial with your key. */
export function signDeny(req: Request, reason: string, signer: Signer): Deny {
  const base = {
    request_id: req.request_id,
    approver_pub: signer.pub,
    reason: reason || undefined,
    issued_at: Date.now(),
  }
  const sig = signer.sign(cborEncode(denyMap(base, null)))
  return { ...base, sig }
}

/** Encode a signed artifact for the wire (the event payload IS this CBOR). */
export function encodeGrant(g: Grant): Uint8Array {
  return cborEncode(grantMap(g, g.sig))
}
export function encodeDeny(d: Deny): Uint8Array {
  return cborEncode(denyMap(d, d.sig))
}

/** Decode an agent's capability request from a decrypted payload. */
export function decodeRequest(b: Uint8Array): Request | null {
  try {
    const o = cborDecode(b) as Record<string, unknown>
    const cap = o.capability as Record<string, unknown> | undefined
    if (!o.request_id || !o.agent_pub || !cap) return null
    return {
      request_id: o.request_id as Uint8Array,
      agent_pub: o.agent_pub as Uint8Array,
      capability: {
        name: String(cap.name ?? ''),
        params: cap.params as Record<string, string> | undefined,
        scope: cap.scope as string | undefined,
        task_id: cap.task_id as string | undefined,
      },
      request_hash: o.request_hash as Uint8Array,
      issued_at: Number(o.issued_at ?? 0),
      expires_at: Number(o.expires_at ?? 0),
      sig: o.sig as Uint8Array,
    }
  } catch {
    return null
  }
}

export function decodeGrant(b: Uint8Array): Grant | null {
  try {
    const o = cborDecode(b) as Record<string, unknown>
    if (!o.request_id || !o.approver_pub) return null
    return {
      request_id: o.request_id as Uint8Array,
      capability_hash: o.capability_hash as Uint8Array,
      agent_pub: o.agent_pub as Uint8Array,
      approver_pub: o.approver_pub as Uint8Array,
      issued_at: Number(o.issued_at ?? 0),
      expires_at: Number(o.expires_at ?? 0),
      sig: o.sig as Uint8Array,
    }
  } catch {
    return null
  }
}

export function decodeDeny(b: Uint8Array): Deny | null {
  try {
    const o = cborDecode(b) as Record<string, unknown>
    if (!o.request_id || !o.approver_pub) return null
    return {
      request_id: o.request_id as Uint8Array,
      approver_pub: o.approver_pub as Uint8Array,
      reason: o.reason as string | undefined,
      issued_at: Number(o.issued_at ?? 0),
      sig: o.sig as Uint8Array,
    }
  } catch {
    return null
  }
}

/** Decode credential_minted, which the EXTERNAL broker emits back into the room. */
export function decodeMinted(b: Uint8Array): { request_id: Uint8Array } | null {
  try {
    const o = cborDecode(b) as Record<string, unknown>
    if (!o.request_id) return null
    return { request_id: o.request_id as Uint8Array }
  } catch {
    return null
  }
}

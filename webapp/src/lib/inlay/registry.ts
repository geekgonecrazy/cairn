// Declaration registry. Declarations are content-addressed: the decl_cid is
// BLAKE3 over the declaration's deterministic CBOR, so identity is the hash, not
// the name — "two declarations both named task_list are different inlays."
//
// What the client SHIPS is deliberately tiny: only approval_prompt, whose flow
// must stay pinned and auditable. Everything else an agent publishes at runtime
// (INLAY_DECL) and the client learns by verified hash — see learnDeclaration.
//
// This is a deliberate reversal. The original design shipped a standard library
// of cards (poll, task_list, agent_panel) and treated novel declarations as the
// exception. That capped agent UI at whatever the client happened to compile in.
// Agent-definable inlays are the general case; the shipped set is the exception,
// reserved for flows that must not be author-defined.
//
// Note the distinction from inlay.md: allowlisting a DECLARATION is curation
// (the role renderer is safe by construction); it is widgets whose allowlisting
// is security.

import { blake3 } from '@noble/hashes/blake3.js'
import { encode as cborEncode } from '../cbor'
import type { Declaration } from './types'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** decl_cid = BLAKE3 over the declaration's deterministic CBOR. */
export function declHash(d: Declaration): string {
  return hex(blake3(cborEncode(d as never)))
}

// ---------------------------------------------------------------------------
// The shipped set: approval only.
//
// Approval is NOT delegated to a declaration an author supplies, because a
// spoofable "grant vent.actuate?" card is a phishing surface. The prompt is
// pinned here and rendered by an audited component (ApprovalInlay.svelte), so
// the flow stays specific and trackable rather than becoming data anyone can
// author.
// ---------------------------------------------------------------------------

const approvalPrompt: Declaration = {
  name: 'approval_prompt',
  version: 1,
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'title', emphasis: 'title' },
    children: [
      {
        role: 'record',
        cols: 2,
        fields: [
          { key: 'Capability', node: { role: 'text', bind: 'capability' } },
          { key: 'Scope', node: { role: 'text', bind: 'scope' } },
        ],
      },
      { role: 'status_enum', bind: 'status' },
    ],
  },
  actions: [
    { id: 'approve', label: 'Approve', kind: 'immediate', variant: 'primary' },
    { id: 'deny', label: 'Deny', kind: 'immediate', variant: 'danger' },
  ],
}

/** Everything the client SHIPS, by decl_cid. Runtime ones live in `learned`. */
export const known = new Map<string, Declaration>()
for (const d of [approvalPrompt]) {
  known.set(declHash(d), d)
}

/** Pre-allowlisted hashes: the shipped set renders without an admin prompt. */
export const STD_CIDS = new Set([declHash(approvalPrompt)])

export const CID = {
  approval_prompt: declHash(approvalPrompt),
}

// ---------------------------------------------------------------------------
// Learned declarations (INLAY_DECL, PROTOCOL.md §3)
// ---------------------------------------------------------------------------
//
// Agents compose UI the standard library never anticipated, so declarations
// arrive as room events rather than only shipping with the client. Learned ones
// live here, keyed by VERIFIED hash: learn() recomputes the cid and refuses any
// declaration whose bytes do not match, which is what makes a decl_cid on the
// wire trustworthy without trusting the sender or the carrier.
//
// A plain Map, deliberately: this module must stay runnable under tsx for
// scripts/inlay-check.ts, and runes only work in .svelte.ts. Reactivity is not
// lost — rebuild() re-creates the message array on every ingest, so a card
// re-derives once its declaration lands, which is the ordering the DAG makes
// normal rather than exceptional.
const learned = new Map<string, { decl: Declaration; authorHex: string }>()

/**
 * Register a declaration carried by an INLAY_DECL event.
 *
 * Returns the cid on success, or null if the bytes hash to something else.
 * A mismatch is not an error to surface: the instance simply stays unresolved
 * and shows its text line, exactly as if the declaration never arrived.
 */
export function learnDeclaration(decl: Declaration, authorHex: string, claimedCid?: string): string | null {
  let cid: string
  try {
    cid = declHash(decl)
  } catch {
    return null // not encodable as deterministic CBOR
  }
  if (claimedCid && claimedCid !== cid) return null
  // First writer wins on the declaration itself — the cid IS the content, so a
  // second copy is either identical or a different declaration under a different
  // cid. The AUTHOR can still fill in later: sender resolution is async, so the
  // first fold often sees the declaration before it can name who published it.
  const prev = learned.get(cid)
  if (!prev) learned.set(cid, { decl, authorHex })
  else if (!prev.authorHex && authorHex) learned.set(cid, { decl: prev.decl, authorHex })
  return cid
}

/** Member root that published a learned declaration, for trust-by-author. */
export function declarationAuthor(cid: string): string | undefined {
  return learned.get(cid)?.authorHex
}

export function forgetLearnedDeclarations() {
  learned.clear()
}

export function resolveDeclaration(cid: string): Declaration | undefined {
  return known.get(cid) ?? learned.get(cid)?.decl
}

// --- per-room allowlist (default-deny admin surface) ---

const allowKey = (room: string) => `cairn-inlay-allow:${room}`

export function allowedInRoom(room: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(allowKey(room)) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/**
 * May this declaration render in this room?
 *
 * Three tiers, default-deny at the bottom:
 *   1. standard library — hashes the client ships
 *   2. explicitly allowed in this room by an admin
 *   3. TRUST BY AUTHOR — published by a current room member
 *
 * Tier 3 is what makes agent-authored UI usable: an agent admitted to a room
 * composes freely, without a human approving every layout it invents. That is
 * curation, not a security boundary — the role renderer is safe by construction
 * (no script, no markup, no colour), so the worst a member can do is post an
 * ugly or misleading card, which is equally true of the chat text beside it.
 * Membership is the gate; an unknown author still shows only its text line.
 *
 * Widgets are the opposite case and stay gated: they are code, not data.
 */
export function isAllowed(cid: string, room: string, roomMemberHexes?: Iterable<string>): boolean {
  if (STD_CIDS.has(cid) || allowedInRoom(room).has(cid)) return true
  const author = declarationAuthor(cid)
  if (!author || !roomMemberHexes) return false
  for (const m of roomMemberHexes) {
    if (m === author) return true
  }
  return false
}

/** Admin action: permit a declaration in this room (default-deny until then). */
export function allowInRoom(cid: string, room: string) {
  const s = allowedInRoom(room)
  s.add(cid)
  localStorage.setItem(allowKey(room), JSON.stringify([...s]))
}

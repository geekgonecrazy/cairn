// Declaration registry. Declarations are content-addressed: the decl_cid is
// BLAKE3 over the declaration's deterministic CBOR, so identity is the hash, not
// the name — "two declarations both named task_list are different inlays."
//
// The standard library is nothing privileged: just declarations whose hashes the
// client ships pre-allowlisted. Per-room additions are a default-deny admin
// surface (plan.md Phase 2). Note the distinction from inlay.md: allowlisting a
// DECLARATION is curation (the role renderer is safe by construction); it is
// widgets whose allowlisting is security.

import { blake3 } from '@noble/hashes/blake3.js'
import { encode as cborEncode } from '../cbor'
import type { Declaration } from './types'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** decl_cid = BLAKE3 over the declaration's deterministic CBOR. */
export function declHash(d: Declaration): string {
  return hex(blake3(cborEncode(d as never)))
}

// ---------------------------------------------------------------------------
// Standard library (inlay.md §standard library)
// ---------------------------------------------------------------------------

const poll: Declaration = {
  name: 'poll',
  version: 1,
  authorless: true, // survives its author; can never be repaired by checkpoint
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'question', emphasis: 'title' },
    children: [
      {
        role: 'list',
        bind: 'options',
        empty: 'No options.',
        item: {
          role: 'group',
          children: [
            { role: 'text', bind: 'label' },
            { role: 'progress_fraction', bind: 'share', polarity: 'neutral' },
          ],
        },
      },
    ],
  },
  actions: [{ id: 'vote', label: 'Vote', kind: 'immediate', variant: 'primary' }],
}

const taskList: Declaration = {
  name: 'task_list',
  version: 1,
  bound_events: ['task_request', 'task_update'],
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'title', emphasis: 'title' },
    children: [
      {
        role: 'record',
        cols: 3,
        fields: [
          { key: 'Running', node: { role: 'number', bind: 'summary.running' } },
          { key: 'Queued', node: { role: 'number', bind: 'summary.queued' } },
          { key: 'Done today', node: { role: 'number', bind: 'summary.done' } },
        ],
      },
      {
        role: 'list',
        bind: 'tasks',
        empty: 'Nothing queued.',
        item: {
          role: 'group',
          children: [
            { role: 'text', bind: 'name' },
            { role: 'status_enum', bind: 'status' },
            { role: 'progress_fraction', bind: 'progress' },
          ],
        },
      },
    ],
  },
  actions: [{ id: 'add_task', label: 'Add task', kind: 'modal', variant: 'primary' }],
}

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

const agentPanel: Declaration = {
  name: 'agent_panel',
  version: 1,
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'agent', emphasis: 'title' },
    children: [
      { role: 'status_enum', bind: 'status' },
      // Composition: a panel is not one fact, it is a whole assembly.
      { role: 'inlay_ref', decl_cid: '', bindings: undefined }, // filled below with task_list's cid
      {
        role: 'group',
        header: { role: 'text', value: 'Capabilities', emphasis: 'note' },
        children: [
          {
            role: 'list',
            bind: 'capabilities',
            empty: 'No capabilities granted.',
            item: {
              role: 'group',
              children: [
                { role: 'text', bind: 'name' },
                // policy chip: auto / human-gated / forbidden
                { role: 'status_enum', bind: 'policy' },
              ],
            },
          },
        ],
      },
    ],
  },
  actions: [
    { id: 'configure', label: 'Configure', kind: 'modal' },
    { id: 'logs', label: 'Logs', kind: 'immediate', variant: 'ghost' },
  ],
}

// ---------------------------------------------------------------------------
// A NOVEL declaration — deliberately NOT standard library. It exists to prove
// the exit criterion: an inlay nobody hardcoded renders from primitives alone,
// and degrades to its text line. Nothing about it is special-cased anywhere.
// ---------------------------------------------------------------------------

const greenhouse: Declaration = {
  name: 'greenhouse_bench',
  version: 1,
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'title', emphasis: 'title' },
    children: [
      { role: 'timestamp', bind: 'updated_at' },
      { role: 'status_enum', bind: 'status' },
      {
        role: 'record',
        cols: 2,
        fields: [
          { key: 'Air temp', node: { role: 'number', bind: 'air_temp', unit: '°C', showTrend: true }, note: 'within 22–26° band' },
          { key: 'Humidity', node: { role: 'number', bind: 'humidity', unit: '%', showTrend: true }, note: 'target 55–70%' },
          { key: 'Soil moisture', node: { role: 'number', bind: 'soil', unit: '%' }, note: 'beds nominal' },
          { key: 'CO₂', node: { role: 'number', bind: 'co2', unit: 'ppm' }, note: 'day cycle' },
        ],
      },
      { role: 'series', bind: 'air_series', polarity: 'positive', band: [22, 26], label: 'Air temp · last 6h' },
    ],
  },
  actions: [
    { id: 'refresh', label: 'Refresh', kind: 'immediate', variant: 'ghost' },
    {
      id: 'vent',
      label: 'Open roof vent',
      kind: 'immediate',
      capability_request: 'vent.actuate(gh_roof)',
      scope: '30 min · this vent only',
    },
  ],
}

// Wire agent_panel's inlay_ref to the real task_list hash (composition by hash).
const TASK_LIST_CID = declHash(taskList)
;(agentPanel.schema as { children: { role: string; decl_cid?: string }[] }).children.forEach((c) => {
  if (c.role === 'inlay_ref') c.decl_cid = TASK_LIST_CID
})

/** Everything the client can resolve, by decl_cid. */
export const known = new Map<string, Declaration>()
for (const d of [poll, taskList, approvalPrompt, agentPanel, greenhouse]) {
  known.set(declHash(d), d)
}

/** Standard library = pre-allowlisted hashes. The novel greenhouse is NOT here. */
export const STD_CIDS = new Set([declHash(poll), declHash(taskList), declHash(approvalPrompt), declHash(agentPanel)])

export const CID = {
  poll: declHash(poll),
  task_list: TASK_LIST_CID,
  approval_prompt: declHash(approvalPrompt),
  agent_panel: declHash(agentPanel),
  greenhouse: declHash(greenhouse),
}

export function resolveDeclaration(cid: string): Declaration | undefined {
  return known.get(cid)
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

export function isAllowed(cid: string, room: string): boolean {
  return STD_CIDS.has(cid) || allowedInRoom(room).has(cid)
}

/** Admin action: permit a declaration in this room (default-deny until then). */
export function allowInRoom(cid: string, room: string) {
  const s = allowedInRoom(room)
  s.add(cid)
  localStorage.setItem(allowKey(room), JSON.stringify([...s]))
}

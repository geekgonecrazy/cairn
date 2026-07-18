// Binding resolution. The sources don't specify a path syntax, so we use the
// simplest thing that covers records and list rows: dotted paths with numeric
// segments indexing arrays — `readings.0.value`. Inside a `list`, the item node
// resolves relative to the current row, so its binds are plain field names.

import type { Bindings, Node } from './types'

/** Look up a dotted path in a bindings object (or a list row). */
export function resolve(scope: unknown, path?: string): unknown {
  if (!path) return undefined
  let cur: unknown = scope
  for (const seg of path.split('.')) {
    if (cur == null) return undefined
    if (Array.isArray(cur)) {
      const i = Number(seg)
      cur = Number.isInteger(i) ? cur[i] : undefined
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

/** A leaf's value: its bind if present, else its literal, else undefined. */
export function valueOf<T>(scope: unknown, bind: string | undefined, literal: T | undefined): T | undefined {
  const v = resolve(scope, bind)
  return (v === undefined ? literal : (v as T))
}

export function asString(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v)
}

export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return undefined
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Rows for a `list` node. */
export function rowsFor(scope: Bindings | unknown, node: Extract<Node, { role: 'list' }>): unknown[] {
  return asArray(resolve(scope, node.bind))
}

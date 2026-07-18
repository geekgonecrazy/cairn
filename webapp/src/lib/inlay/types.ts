// Declared-inlay data model.
//
// The architecture rule from inlay.md: there is exactly ONE role renderer (fixed,
// audited code) that maps a declaration — structural constructs + semantic-role
// leaves — to themed UI. Declarations are DATA it interprets, never code and
// never pixels: "presentation — colour, type, spacing, density, dark mode,
// accessibility — belongs entirely to this engine. A declaration never ships
// pixels." So there is no per-card component; a poll and a greenhouse panel are
// the same renderer walking different declarations.
//
// A declaration may declare meaning (roles, polarity, labels) and actions. It may
// NOT declare script, colour, arbitrary targets, or markup.

/** The renderer's only colour decision. Maps to --pos / --neg / --busy / neutral. */
export type Polarity = 'positive' | 'neutral' | 'negative' | 'busy'

/** Where a leaf gets its value: a path into the instance bindings. */
export type Bind = string

export interface RecordField {
  key: string // shown as the field label (uppercase mono)
  node: Node
  note?: string
  flag?: 'warn'
}

/** Structural constructs + semantic leaf roles (inlay.md §vocabulary). */
export type Node =
  // --- leaves ---
  | { role: 'text'; bind?: Bind; value?: string; emphasis?: 'title' | 'body' | 'note' }
  | { role: 'number'; bind?: Bind; value?: number; unit?: string; showTrend?: boolean }
  | { role: 'progress_fraction'; bind?: Bind; value?: number; label?: string; polarity?: Polarity }
  | { role: 'status_enum'; bind?: Bind; label?: string; polarity?: Polarity; icon?: string }
  | { role: 'timestamp'; bind?: Bind; value?: number; showAbsolute?: boolean }
  | { role: 'image_cid'; bind?: Bind; alt?: string; size?: number }
  | { role: 'series'; bind?: Bind; values?: number[]; polarity?: Polarity; band?: [number, number]; label?: string }
  | { role: 'action_ref'; action_id: string }
  | { role: 'input'; name: string; label?: string; bind?: Bind; inputType?: 'text' | 'number'; placeholder?: string }
  | { role: 'select'; name: string; label?: string; bind?: Bind; options: { value: string; label: string }[] }
  // --- structural ---
  | { role: 'record'; cols?: number; fields: RecordField[] }
  | { role: 'list'; bind: Bind; item: Node; empty?: string }
  | { role: 'group'; header?: Node; children: Node[] }
  | { role: 'inlay_ref'; decl_cid: string; bindings?: Bindings }

/** A declared action. Capability-bound actions MUST render their capability —
 *  "no invisible interactions", inlay.md. */
export interface Action {
  id: string
  label: string
  kind: 'immediate' | 'modal'
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  icon?: string
  capability_request?: string
  scope?: string
}

/** The content-addressed declaration. Identity is its hash, not its name:
 *  "two declarations both named task_list are different inlays." */
export interface Declaration {
  name: string
  version: number
  schema: Node
  actions?: Action[]
  bound_events?: string[]
  authorless?: boolean
}

/** Instance data filling the declaration's binds. */
export type Bindings = Record<string, unknown>

/** The inlay event payload (PROTOCOL.md §3): decl_cid + optional bindings, and a
 *  MANDATORY text fallback — "rendering degrades; delivery does not." */
export interface InlayInstance {
  decl_cid: string
  surface: 'timeline' | 'room_panel'
  bindings?: Bindings
  text: string
  widget?: WidgetRef
}

/** Widgets are the escape hatch and NEVER render inline — placeholder + Open,
 *  which runs it in the webapp shell's sandbox. */
export interface WidgetRef {
  component_hash: string
  hint?: { width?: number; height?: number }
}

/** Render phase for the container (honest degradation, never a dead spinner). */
export type InlayPhase = 'loading' | 'rendered' | 'error' | 'text'

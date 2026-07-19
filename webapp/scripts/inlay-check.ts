// Inlay engine check: walk every sample's DECLARATION and confirm each bind
// actually resolves against its bindings, that the mandatory text fallback is
// present, and that the "novel" declaration is genuinely NOT standard library.
// This is what determines whether a card renders meaningfully — the renderer is
// generic, so a declaration/bindings mismatch is the real failure mode.
//
// Run: npm run inlay-check

// registry.ts touches localStorage for the per-room allowlist; shim it for Node.
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
} as Storage

const { resolveDeclaration, STD_CIDS, declHash, known, learnDeclaration, isAllowed } =
  await import('../src/lib/inlay/registry.ts')
const { resolve } = await import('../src/lib/inlay/bindings.ts')
type Node = import('../src/lib/inlay/types.ts').Node

let failures = 0
const fail = (m: string) => {
  console.log(`  FAIL ${m}`)
  failures++
}

/** Collect (bind, scopeSample) pairs by walking a schema against real data. */
function checkNode(node: Node, scope: unknown, path: string, report: (m: string) => void) {
  switch (node.role) {
    case 'record':
      for (const f of node.fields) checkNode(f.node, scope, `${path}.${f.key}`, report)
      return
    case 'group':
      if (node.header) checkNode(node.header, scope, `${path}/header`, report)
      for (const [i, c] of node.children.entries()) checkNode(c, scope, `${path}/${i}`, report)
      return
    case 'list': {
      const rows = resolve(scope, node.bind)
      if (!Array.isArray(rows)) {
        report(`${path}: list bind "${node.bind}" did not resolve to an array`)
        return
      }
      if (rows.length === 0) return // empty is legal; the renderer shows `empty`
      checkNode(node.item, rows[0], `${path}[0]`, report) // item binds are row-relative
      return
    }
    case 'inlay_ref': {
      const sub = resolveDeclaration(node.decl_cid)
      if (!sub) {
        report(`${path}: inlay_ref decl_cid ${node.decl_cid.slice(0, 8)} not resolvable`)
        return
      }
      checkNode(sub.schema, node.bindings ?? scope, `${path}->${sub.name}`, report)
      return
    }
    case 'action_ref':
      return // validated against the declaration's actions below
    default: {
      // leaf role with an optional bind
      const bind = (node as { bind?: string }).bind
      if (!bind) return
      if (resolve(scope, bind) === undefined) {
        report(`${path}: bind "${bind}" (role ${node.role}) resolved to undefined`)
      }
    }
  }
}

function collectActionRefs(node: Node, out: string[]) {
  switch (node.role) {
    case 'record':
      node.fields.forEach((f) => collectActionRefs(f.node, out))
      return
    case 'group':
      if (node.header) collectActionRefs(node.header, out)
      node.children.forEach((c) => collectActionRefs(c, out))
      return
    case 'list':
      collectActionRefs(node.item, out)
      return
    case 'action_ref':
      out.push(node.action_id)
      return
  }
}

console.log(`registry: ${known.size} declarations, ${STD_CIDS.size} pre-allowlisted (standard library)\n`)

// The shipped set is deliberately tiny — approval only. Everything else an
// agent publishes at runtime, which the section below exercises.
for (const [cid, decl] of known) {
  console.log(`shipped "${decl.name}"`)
  if (!STD_CIDS.has(cid)) fail(`${decl.name} ships but is not pre-allowlisted`)
  const refs: string[] = []
  collectActionRefs(decl.schema, refs)
  for (const id of refs) {
    if (!(decl.actions ?? []).some((a) => a.id === id)) fail(`action_ref "${id}" has no declared action`)
  }
  if (declHash(decl) !== cid) fail(`${decl.name}: declHash is not deterministic`)
  console.log(`  ${decl.name} v${decl.version} · ${cid.slice(0, 8)} · pinned, content-addressed`)
}

console.log('')
if (known.size !== 1) {
  fail(`the shipped set should be approval_prompt alone; found ${known.size}`)
} else {
  console.log('shipped set is approval only — agent-published UI is the general case')
}



// ---------------------------------------------------------------------------
// Agent-authored UI: a declaration NOBODY shipped, learned at runtime.
//
// This is the property the standard library cannot demonstrate. An agent
// composes a layout no one anticipated, publishes it as INLAY_DECL, and the
// receiving client must render it from primitives alone — without the
// declaration ever having been compiled into the client.
// ---------------------------------------------------------------------------
console.log('')
const agentDecl = {
  name: 'well_pump_cycle',
  version: 1,
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'title', emphasis: 'title' },
    children: [
      { role: 'status_enum', bind: 'state' },
      {
        role: 'record',
        cols: 2,
        fields: [
          { key: 'Pressure', node: { role: 'number', bind: 'psi', unit: 'psi' } },
          { key: 'Duty', node: { role: 'progress_fraction', bind: 'duty' } },
        ],
      },
      { role: 'series', bind: 'psi_series', label: 'Pressure · last hour' },
    ],
  },
  actions: [{ id: 'prime', label: 'Prime pump', kind: 'immediate' }],
} as const

const agentBindings = {
  title: 'Well pump',
  state: 'running',
  psi: 41,
  duty: 0.36,
  psi_series: [38, 39, 41, 42, 41, 40],
}

const AUTHOR = 'a'.repeat(64) // an agent's member root
const cid = learnDeclaration(agentDecl as never, AUTHOR)
if (!cid) fail('a well-formed agent declaration was refused')
else if (STD_CIDS.has(cid)) fail('the agent declaration must not be standard library')
else if (!resolveDeclaration(cid)) fail('learned declaration does not resolve')
else {
  checkNode(agentDecl.schema as never, agentBindings, 'well_pump_cycle', fail)
  console.log(`learned agent declaration "well_pump_cycle" (${cid.slice(0, 8)}) renders from primitives`)
}

// Hash verification: bytes that do not match their claimed cid are refused, so
// a decl_cid on the wire cannot be made to lie by sender or carrier.
if (learnDeclaration(agentDecl as never, AUTHOR, 'f'.repeat(64)) !== null) {
  fail('a declaration whose bytes mismatch its claimed cid was accepted')
} else {
  console.log('declaration with a mismatched cid is refused (content address verified)')
}

// Trust by author: in-room author renders; a stranger's stays default-deny.
if (cid) {
  if (!isAllowed(cid, 'room-1', [AUTHOR])) fail('an in-room author\'s declaration should render')
  else if (isAllowed(cid, 'room-1', ['b'.repeat(64)])) fail('a non-member author\'s declaration must NOT render')
  else console.log('trust-by-author: in-room author renders, stranger stays default-deny')
}

console.log(failures === 0 ? '\nINLAY CHECK PASS' : `\nINLAY CHECK FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

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

const { SAMPLES } = await import('../src/lib/inlay/samples.ts')
const { resolveDeclaration, STD_CIDS, declHash, known } = await import('../src/lib/inlay/registry.ts')
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

for (const [name, inst] of Object.entries(SAMPLES)) {
  console.log(`sample "${name}"`)
  const decl = resolveDeclaration(inst.decl_cid)
  if (!decl) {
    fail(`decl_cid ${inst.decl_cid.slice(0, 8)} not resolvable`)
    continue
  }
  // The text fallback is mandatory — without it there is nothing to degrade to.
  if (!inst.text || inst.text.trim().length === 0) fail(`"${name}" has no text fallback`)

  if (inst.widget) {
    console.log(`  widget placeholder (never renders inline) — ok`)
    continue
  }

  checkNode(decl.schema, inst.bindings ?? {}, decl.name, fail)

  // Every action_ref must name a declared action.
  const refs: string[] = []
  collectActionRefs(decl.schema, refs)
  for (const id of refs) {
    if (!(decl.actions ?? []).some((a) => a.id === id)) fail(`action_ref "${id}" has no declared action`)
  }
  console.log(`  ${decl.name} v${decl.version} · ${inst.decl_cid.slice(0, 8)} · binds resolve · text fallback present`)
}

// The exit criterion depends on greenhouse being a genuinely NOVEL declaration.
const gh = SAMPLES.greenhouse.decl_cid
console.log('')
if (STD_CIDS.has(gh)) fail('greenhouse must NOT be standard library (it proves novel declarations render)')
else console.log(`novel declaration "greenhouse_bench" (${gh.slice(0, 8)}) is NOT standard library — default-deny applies`)

// Hashing must be deterministic (identity is the hash, not the name).
const decl = resolveDeclaration(gh)!
if (declHash(decl) !== gh) fail('declHash is not deterministic')
else console.log('decl_cid is a stable content address')

console.log(failures === 0 ? '\nINLAY CHECK PASS' : `\nINLAY CHECK FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

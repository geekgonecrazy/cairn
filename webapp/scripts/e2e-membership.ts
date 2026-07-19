// END-TO-END membership test, running the REAL browser client code.
//
// This exists because every previous check exercised the Go side and *assumed*
// the TypeScript worked. The bugs were all in the TypeScript. This imports
// crypto.ts itself — the same mintEpoch, wrapKeyTo, applyKeyEvent and unwrapKey
// the app runs — and drives two clients through the exact flow that keeps
// failing:
//
//   Aaron: join -> create space -> create room -> post a message
//   Aaron: add Joe to the room
//   Joe:   sync the room and try to read
//
// Run against a live cairnd:  npx tsx scripts/e2e-membership.ts "<household phrase>"
//
// Two localStorage stores are swapped in and out to impersonate two devices in
// one process, because crypto.ts reads storage on every call rather than caching.

const stores: Record<string, Record<string, string>> = {}
let active = 'aaron'

function makeStorage(pick: () => Record<string, string>) {
  return {
    getItem: (k: string) => pick()[k] ?? null,
    setItem: (k: string, v: string) => { pick()[k] = v },
    removeItem: (k: string) => { delete pick()[k] },
    clear: () => { for (const k of Object.keys(pick())) delete pick()[k] },
  }
}
const backing = () => (stores[active] ??= {})
;(globalThis as any).localStorage = makeStorage(backing)
;(globalThis as any).sessionStorage = makeStorage(backing)

// The app's transport uses a relative baseUrl (same-origin in a browser).
// Rewrite relative requests to the dev server.
const BASE = process.env.CAIRN_ADDR ?? 'http://127.0.0.1:8099'
const realFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any) => {
  if (typeof input === 'string' && input.startsWith('/')) return realFetch(BASE + input, init)
  if (input instanceof URL && input.protocol === 'file:') {
    return realFetch(BASE + input.pathname, init)
  }
  if (input instanceof Request && input.url.startsWith('file://')) {
    const u = new URL(input.url)
    return realFetch(new Request(BASE + u.pathname, input as any), init)
  }
  return realFetch(input, init)
}) as typeof fetch

const {
  memberRootFromMnemonic, provisionMember, approvePairing, newPairingRequest,
  signSessionDelegation,
} = await import('../src/lib/identity.ts')
const {
  buildSpaceCreate, buildSpaceMemberAdd, buildRoomCreate, buildMemberAdd,
  buildChat, buildInlay, buildInlayDecl, applyKeyEvent, openEvent, verifyEvent,
  haveRoomKey, sessionPub,
} = await import('../src/lib/crypto.ts')
const { declHash, learnDeclaration, resolveDeclaration, STD_CIDS } =
  await import('../src/lib/inlay/registry.ts')
const { cairn } = await import('../src/lib/api.ts')
const { encode: cborEncode } = await import('../src/lib/cbor.ts')

const HOUSEHOLD = process.argv[2]
if (!HOUSEHOLD) throw new Error('pass the household recovery phrase as argv[2]')

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Provision a member the way the app does, and publish them to the carrier. */
async function setupClient(slot: string, mnemonic: string, name: string) {
  active = slot
  const member = memberRootFromMnemonic(mnemonic)
  const devicePriv = new Uint8Array(32)
  crypto.getRandomValues(devicePriv)
  const { ed25519 } = await import('@noble/curves/ed25519.js')
  const devicePub = ed25519.getPublicKey(devicePriv)

  const att = provisionMember(HOUSEHOLD, '', member.pub, 'human', name, null, BigInt(Date.now()))
  const dd = approvePairing(
    newPairingRequest(devicePub, `${name}-device`), member.pub, member.priv, BigInt(Date.now()))

  // Exactly what vault.persist writes.
  localStorage.setItem('cairn-member-pub', b64(member.pub))
  localStorage.setItem('cairn-device-sk', b64(devicePriv))

  // Events are signed by the per-tab SESSION key, which must chain to the
  // device key — identity.bindSession() does this in the app. Without it the
  // carrier rejects every event with "chain link not found".
  const sd = signSessionDelegation(
    sessionPub(), devicePub, devicePriv, 'chat', BigInt(Date.now() + 86_400_000))

  for (const o of [att, dd, sd]) {
    await cairn.putIdentityObject({ cbor: cborEncode(o as any) })
  }
  return { member, devicePub, devicePriv, att, dd, sd }
}

console.log('e2e membership (real client code against a live cairnd)\n')

// --- Aaron sets up, creates a room, posts ---------------------------------
const AARON_WORDS =
  'legal winner thank year wave sausage worth useful legal winner thank year ' +
  'wave sausage worth useful legal winner thank year wave sausage worth title'
const JOE_WORDS =
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd ' +
  'amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless'

const aaron = await setupClient('aaron', AARON_WORDS, 'Aaron')
const joe = await setupClient('joe', JOE_WORDS, 'Joe')
console.log(`  aaron member ${hex(aaron.member.pub).slice(0, 12)} device ${hex(aaron.devicePub).slice(0, 12)}`)
console.log(`  joe   member ${hex(joe.member.pub).slice(0, 12)} device ${hex(joe.devicePub).slice(0, 12)}\n`)

const stamp = Date.now().toString(36)
const spaceId = `sp-e2e-${stamp}`
const roomId = `room-e2e-${stamp}`

active = 'aaron'
await cairn.sendEvent({ event: await buildSpaceCreate(spaceId, 'E2E Space') })
await cairn.sendEvent({ event: await buildSpaceMemberAdd(spaceId, aaron.member.pub, 'admin') })
await cairn.sendEvent({ event: await buildRoomCreate(roomId, 'E2E Room', spaceId) })
await cairn.sendEvent({ event: await buildMemberAdd(roomId, aaron.member.pub, 'admin', [], []) })
check('aaron holds the room key after creating it', haveRoomKey(roomId))

const beforeText = 'message BEFORE joe was added'
await cairn.sendEvent({ event: await buildChat(roomId, { text: beforeText }, []) })

// --- Aaron adds Joe -------------------------------------------------------
active = 'aaron'
const addEv = await buildMemberAdd(roomId, joe.member.pub, 'member', [aaron.member.pub], [])
await cairn.sendEvent({ event: addEv })

// Did the add actually wrap to Joe's DEVICE? This is the step that silently
// produced keys nobody could open.
const { decode: cborDecode } = await import('../src/lib/cbor.ts')
const addPayload = cborDecode(addEv.payload.subarray(1)) as any
const wrappedTo = Object.keys(addPayload.wrapped_keys ?? {})
check('member_add wraps to joe\'s device', wrappedTo.includes(hex(joe.devicePub)),
  `wrapped to ${wrappedTo.map((k) => k.slice(0, 12)).join(', ')}`)
check('member_add wraps to aaron\'s device', wrappedTo.includes(hex(aaron.devicePub)))

const afterText = 'message AFTER joe was added'
await cairn.sendEvent({ event: await buildChat(roomId, { text: afterText }, []) })

// --- Joe syncs and tries to read -----------------------------------------
active = 'joe'
const sync = await cairn.sync({ roomId: new TextEncoder().encode(roomId), haveHeads: [] })
console.log(`\n  joe synced ${sync.missing.length} events`)

let applied = 0
let applyError = ''
for (const ev of sync.missing) {
  if (!verifyEvent(ev)) {
    check('joe verifies every synced event', false, `event type ${ev.type} failed verifyEvent`)
    continue
  }
  try {
    if (await applyKeyEvent(ev)) applied++
  } catch (e) {
    applyError = e instanceof Error ? e.message : String(e)
  }
}
check('joe applied a key event', applied > 0, applyError || `applied=${applied}`)
check('joe holds a room key', haveRoomKey(roomId), applyError)

// The actual question: can Joe read?
let sawAfter = false
let sawBefore = false
for (const ev of sync.missing) {
  const d = await openEvent(ev)
  if (d?.kind === 'chat') {
    if (d.text === afterText) sawAfter = true
    if (d.text === beforeText) sawBefore = true
  }
}
check('joe can read messages sent AFTER he was added', sawAfter)
check('joe canNOT read pre-join history (by design)', !sawBefore,
  sawBefore ? 'he could read it — pre-join opacity is broken' : 'correct: opaque')

// --- Agent-authored UI: a declaration that travels over the wire ----------
//
// The standard library proves the renderer works; it cannot prove an AGENT can
// define UI. So: publish a declaration no client ships, reference it from an
// instance, and confirm the receiving side learns it from the event alone and
// resolves the instance against it.
console.log('\n--- agent-authored inlay declaration ---')
active = 'aaron'
const wellPump = {
  name: 'well_pump_cycle',
  version: 1,
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'title', emphasis: 'title' },
    children: [
      { role: 'status_enum', bind: 'state' },
      { role: 'number', bind: 'psi', unit: 'psi' },
    ],
  },
  actions: [{ id: 'prime', label: 'Prime pump', kind: 'immediate' }],
}
const wellCid = declHash(wellPump as never)
check('agent declaration is NOT in the shipped standard library', !STD_CIDS.has(wellCid), wellCid.slice(0, 8))

const declEvent = await buildInlayDecl(roomId, wellPump, [])
try {
  await cairn.sendEvent({ event: declEvent })
  check('carrier accepted the INLAY_DECL event', true)
} catch (e) {
  check('carrier accepted the INLAY_DECL event', false, e instanceof Error ? e.message : String(e))
}
const instEvent = await buildInlay(
  roomId,
  { decl_cid: wellCid, bindings: { title: 'Well pump', state: 'running', psi: 41 }, text: 'Well pump: running, 41 psi' },
  [],
)
try {
  await cairn.sendEvent({ event: instEvent })
  check('carrier accepted the INLAY instance', true)
} catch (e) {
  check('carrier accepted the INLAY instance', false, e instanceof Error ? e.message : String(e))
}

active = 'joe'
const declSync = await cairn.sync({ roomId: new TextEncoder().encode(roomId), haveHeads: [] })
let learnedCid: string | null = null
let instanceCid = ''
let fallbackText = ''
for (const ev of declSync.missing) {
  const d = await openEvent(ev)
  if (d?.kind === 'inlay_decl') learnedCid = learnDeclaration(d.decl as never, 'aaron-member')
  if (d?.kind === 'inlay' && d.instance.decl_cid === wellCid) {
    instanceCid = d.instance.decl_cid
    fallbackText = d.instance.text
  }
}
check('joe learned the declaration from the event', learnedCid === wellCid, learnedCid?.slice(0, 8) ?? 'none')
check('joe resolves the instance against it', !!instanceCid && !!resolveDeclaration(instanceCid),
  resolveDeclaration(instanceCid)?.name ?? 'unresolved')
check('the instance still carries its mandatory text fallback', fallbackText.length > 0, fallbackText)

// --- The escape hatch: adding someone WITH history sharing ---------------
//
// The default above is pre-join opacity, which is correct but is also exactly
// what "I added someone and they can't see the messages" looks like. So the
// share-history path has to work, or there is no way to get the intended
// behaviour at all. It was rewritten when history_keys became nested
// epoch -> device, and has never been exercised.
console.log('\n--- share_history = true ---')
active = 'aaron'
const room2 = `room-hist-${stamp}`
await cairn.sendEvent({ event: await buildRoomCreate(room2, 'History Room', spaceId) })
await cairn.sendEvent({ event: await buildMemberAdd(room2, aaron.member.pub, 'admin', [], []) })
const oldText = 'history message posted before joe existed here'
await cairn.sendEvent({ event: await buildChat(room2, { text: oldText }, []) })

const shareEv = await buildMemberAdd(
  room2, joe.member.pub, 'member', [aaron.member.pub], [], true /* shareHistory */)
await cairn.sendEvent({ event: shareEv })

const sharePayload = cborDecode(shareEv.payload.subarray(1)) as any
const histEpochs = Object.keys(sharePayload.history_keys ?? {})
check('member_add carries history_keys', histEpochs.length > 0,
  `epochs: ${histEpochs.join(',') || 'none'}`)
const perDevice = Object.keys(sharePayload.history_keys?.[histEpochs[0]] ?? {})
check('history_keys are wrapped per DEVICE', perDevice.includes(hex(joe.devicePub)),
  `wrapped to ${perDevice.map((k) => k.slice(0, 12)).join(', ') || 'nobody'}`)
check('history_shared is recorded in the signed payload', sharePayload.history_shared === true)

active = 'joe'
const sync2 = await cairn.sync({ roomId: new TextEncoder().encode(room2), haveHeads: [] })
for (const ev of sync2.missing) {
  if (!verifyEvent(ev)) continue
  try { await applyKeyEvent(ev) } catch (e) {
    check('joe applies the history-sharing add', false, e instanceof Error ? e.message : String(e))
  }
}
let sawHistory = false
for (const ev of sync2.missing) {
  const d = await openEvent(ev)
  if (d?.kind === 'chat' && d.text === oldText) sawHistory = true
}
check('joe CAN read pre-join history when it was shared', sawHistory)

console.log(failures === 0 ? '\nPASS: all membership paths work' : `\nFAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

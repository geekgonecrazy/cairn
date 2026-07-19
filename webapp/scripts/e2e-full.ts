// THE FULL FLOW, end to end, in the real client code:
//
//   1. Aaron and Joe both join the household
//   2. Aaron creates a space + channel and adds Joe
//   3. BOTH send messages; each must read the other's
//   4. Aaron pairs a second device (phone)
//   5. The phone must read new messages
//   6. AND Joe must still be able to read — the pairing rotation must not
//      lock out the other member
//
// Step 6 is the case none of the narrower tests covered: every earlier test had
// one member in the room, so a rotation that dropped everyone else would still
// have passed.
//
// Run:  npm run e2e-full -- "<household phrase>"

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

const BASE = process.env.CAIRN_ADDR ?? 'http://127.0.0.1:8099'
const realFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any) => {
  if (typeof input === 'string' && input.startsWith('/')) return realFetch(BASE + input, init)
  if (input instanceof Request && input.url.startsWith('file://')) {
    const u = new URL(input.url)
    return realFetch(new Request(BASE + u.pathname, input as any), init)
  }
  return realFetch(input, init)
}) as typeof fetch

const {
  memberRootFromMnemonic, provisionMember, approvePairing, newPairingRequest,
  signSessionDelegation, parsePairingRequest,
} = await import('../src/lib/identity.ts')
const {
  buildSpaceCreate, buildSpaceMemberAdd, buildRoomCreate, buildMemberAdd,
  buildChat, buildRoomKeyRotate, applyKeyEvent, openEvent, verifyEvent,
  haveRoomKey, sessionPub,
} = await import('../src/lib/crypto.ts')
const { beginDevicePairing, completeDevicePairing, admitDevice } =
  await import('../src/lib/vault.ts')
const { cairn } = await import('../src/lib/api.ts')
const { encode: cborEncode, decode: cborDecode } = await import('../src/lib/cbor.ts')
const { ed25519 } = await import('@noble/curves/ed25519.js')

const HOUSEHOLD = process.argv[2]
if (!HOUSEHOLD) throw new Error('pass the household recovery phrase as argv[2]')

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const enc = (o: unknown) => cborEncode(o as any)
const utf8 = (s: string) => new TextEncoder().encode(s)

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Read a room as whoever is `active`: sync, apply keys, return the texts. */
async function readRoom(roomId: string): Promise<string[]> {
  const sync = await cairn.sync({ roomId: utf8(roomId), haveHeads: [] })
  for (const ev of sync.missing) {
    if (!verifyEvent(ev)) continue
    try { await applyKeyEvent(ev) } catch { /* surfaced separately by the app */ }
  }
  const out: string[] = []
  for (const ev of sync.missing) {
    const d = await openEvent(ev)
    if (d?.kind === 'chat' && d.text) out.push(d.text)
  }
  return out
}

/** Provision a member + first device, publish everything. */
async function join(slot: string, words: string, name: string) {
  active = slot
  const member = memberRootFromMnemonic(words)
  const devicePriv = new Uint8Array(32)
  crypto.getRandomValues(devicePriv)
  const devicePub = ed25519.getPublicKey(devicePriv)
  const att = provisionMember(HOUSEHOLD, '', member.pub, 'human', name, null, BigInt(Date.now()))
  const deleg = approvePairing(
    newPairingRequest(devicePub, `${name}-laptop`), member.pub, member.priv, BigInt(Date.now()))

  localStorage.setItem('cairn-member-pub', b64(member.pub))
  localStorage.setItem('cairn-device-sk', b64(devicePriv))
  localStorage.setItem('cairn-household-pub', b64(att.origin))

  const sd = signSessionDelegation(
    sessionPub(), devicePub, devicePriv, 'chat', BigInt(Date.now() + 86_400_000))
  for (const o of [att, deleg, sd]) await cairn.putIdentityObject({ cbor: enc(o) })
  return { member, devicePub, devicePriv, att, deleg }
}

console.log('e2e FULL: two users, a channel, messages, then a second device\n')

const AARON_WORDS =
  'legal winner thank year wave sausage worth useful legal winner thank year ' +
  'wave sausage worth useful legal winner thank year wave sausage worth title'
const JOE_WORDS =
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd ' +
  'amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless'

// --- 1. both join ---------------------------------------------------------
const aaron = await join('aaron', AARON_WORDS, 'Aaron')
const joe = await join('joe', JOE_WORDS, 'Joe')
console.log(`  aaron ${hex(aaron.member.pub).slice(0, 12)} / laptop ${hex(aaron.devicePub).slice(0, 12)}`)
console.log(`  joe   ${hex(joe.member.pub).slice(0, 12)} / laptop ${hex(joe.devicePub).slice(0, 12)}\n`)

// --- 2. Aaron makes a channel and adds Joe --------------------------------
const stamp = Date.now().toString(36)
const spaceId = `sp-${stamp}`
const roomId = `chan-${stamp}`

active = 'aaron'
await cairn.sendEvent({ event: await buildSpaceCreate(spaceId, 'Home') })
await cairn.sendEvent({ event: await buildSpaceMemberAdd(spaceId, aaron.member.pub, 'admin') })
await cairn.sendEvent({ event: await buildSpaceMemberAdd(spaceId, joe.member.pub, 'member') })
await cairn.sendEvent({ event: await buildRoomCreate(roomId, 'general', spaceId) })
await cairn.sendEvent({ event: await buildMemberAdd(roomId, aaron.member.pub, 'admin', [], []) })
await cairn.sendEvent({
  event: await buildMemberAdd(roomId, joe.member.pub, 'member', [aaron.member.pub], []),
})
check('aaron holds the channel key', haveRoomKey(roomId))

// --- 3. both talk, both read ---------------------------------------------
const aaronMsg = 'aaron: hello from the laptop'
await cairn.sendEvent({ event: await buildChat(roomId, { text: aaronMsg }, []) })

active = 'joe'
let joeSees = await readRoom(roomId)
check('joe holds the channel key', haveRoomKey(roomId))
check('joe reads aaron\'s message', joeSees.includes(aaronMsg), joeSees.join(' | ') || 'nothing')

const joeMsg = 'joe: hello back'
await cairn.sendEvent({ event: await buildChat(roomId, { text: joeMsg }, []) })

active = 'aaron'
let aaronSees = await readRoom(roomId)
check('aaron reads joe\'s message', aaronSees.includes(joeMsg), aaronSees.join(' | ') || 'nothing')

// --- 4. Aaron pairs a phone ----------------------------------------------
active = 'phone'
const pairing = beginDevicePairing('phone')

active = 'aaron'
const scanned = parsePairingRequest(pairing.code)
const aaronIdentity = {
  memberPub: aaron.member.pub, devicePub: aaron.devicePub, devicePriv: aaron.devicePriv,
  householdPub: aaron.att.origin, attestation: aaron.att, delegation: aaron.deleg,
  displayName: 'Aaron', kind: 'human' as const, deviceLabel: 'laptop',
}
const phoneDeleg = admitDevice(aaronIdentity as any, scanned.devicePub, 'phone')
await cairn.putIdentityObject({ cbor: enc(phoneDeleg) })

// This mirrors AppState.rewrapForNewDevice: rotate to the CURRENT ROSTER, which
// in a real channel is more than one member. Wrapping only to yourself here is
// exactly how pairing a device would evict everybody else.
const roster = [aaron.member.pub, joe.member.pub]
const rotate = await buildRoomKeyRotate(roomId, roster, [])
await cairn.sendEvent({ event: rotate })

const rotWrapped = Object.keys((cborDecode(rotate.payload.subarray(1)) as any).wrapped_keys ?? {})
check('rotation wraps to the phone', rotWrapped.includes(hex(pairing.devicePub)))
check('rotation still wraps to aaron\'s laptop', rotWrapped.includes(hex(aaron.devicePub)))
check('rotation still wraps to JOE\'s device', rotWrapped.includes(hex(joe.devicePub)),
  rotWrapped.map((k) => k.slice(0, 12)).join(', '))

// --- 5. phone completes pairing and reads --------------------------------
active = 'phone'
const resolved = await cairn.resolveSender({ senderPub: pairing.devicePub })
const chain = (resolved.deviceDelegations ?? []).map((b) => cborDecode(b) as any)
const attBack = resolved.attestation ? (cborDecode(resolved.attestation) as any) : null
let phoneOk = false
try {
  completeDevicePairing(chain, attBack)
  phoneOk = true
} catch (e) {
  check('phone completes pairing', false, e instanceof Error ? e.message : String(e))
}
if (phoneOk) check('phone completes pairing', true)

active = 'aaron'
const afterPairing = 'aaron: sent after pairing the phone'
await cairn.sendEvent({ event: await buildChat(roomId, { text: afterPairing }, []) })

active = 'phone'
const phoneSees = await readRoom(roomId)
check('phone holds the channel key', haveRoomKey(roomId))
check('phone reads messages sent after pairing', phoneSees.includes(afterPairing),
  phoneSees.join(' | ') || 'nothing')

// --- 6. the regression that matters: is everyone ELSE still fine? --------
active = 'joe'
joeSees = await readRoom(roomId)
check('JOE can still read after aaron paired a device', joeSees.includes(afterPairing),
  joeSees.join(' | ') || 'nothing')

const joeAfter = 'joe: still here after the pairing'
await cairn.sendEvent({ event: await buildChat(roomId, { text: joeAfter }, []) })

active = 'aaron'
aaronSees = await readRoom(roomId)
check('aaron still reads joe after pairing', aaronSees.includes(joeAfter),
  aaronSees.join(' | ') || 'nothing')

active = 'phone'
const phoneFinal = await readRoom(roomId)
check('phone reads joe\'s later message too', phoneFinal.includes(joeAfter),
  phoneFinal.join(' | ') || 'nothing')

console.log(failures === 0
  ? '\nPASS: two users + a paired second device all read the same channel'
  : `\nFAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

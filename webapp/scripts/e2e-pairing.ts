// END-TO-END device pairing test, running the REAL client code (vault.ts +
// crypto.ts), against a live cairnd.
//
//   laptop: join, create room, post a message
//   phone:  beginDevicePairing -> shows a code
//   laptop: admitDevice -> publish delegation -> re-wrap room keys
//   phone:  completeDevicePairing -> sync -> can it read?
//
// Run:  npx tsx scripts/e2e-pairing.ts "<household phrase>"

const stores: Record<string, Record<string, string>> = {}
let active = 'laptop'

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
type DeviceDelegation = Awaited<ReturnType<typeof import('../src/lib/identity.ts')['approvePairing']>>
type IdentityAttestation = ReturnType<typeof import('../src/lib/identity.ts')['provisionMember']>
const {
  buildSpaceCreate, buildSpaceMemberAdd, buildRoomCreate, buildMemberAdd,
  buildChat, buildRoomKeyRotate, applyKeyEvent, openEvent, verifyEvent,
  haveRoomKey, sessionPub,
} = await import('../src/lib/crypto.ts')
const {
  beginDevicePairing, pendingDevicePairing, completeDevicePairing, admitDevice,
  loadIdentity,
} = await import('../src/lib/vault.ts')
const { cairn } = await import('../src/lib/api.ts')
const { encode: cborEncode, decode: cborDecode } = await import('../src/lib/cbor.ts')

const HOUSEHOLD = process.argv[2]
if (!HOUSEHOLD) throw new Error('pass the household recovery phrase as argv[2]')

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const enc = (o: unknown) => cborEncode(o as any)

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('e2e device pairing (real vault + crypto against a live cairnd)\n')

// --- laptop: a fully set-up member with a room ----------------------------
const WORDS =
  'legal winner thank year wave sausage worth useful legal winner thank year ' +
  'wave sausage worth useful legal winner thank year wave sausage worth title'

active = 'laptop'
const member = memberRootFromMnemonic(WORDS)
const { ed25519 } = await import('@noble/curves/ed25519.js')
const laptopPriv = new Uint8Array(32)
crypto.getRandomValues(laptopPriv)
const laptopPub = ed25519.getPublicKey(laptopPriv)

const att = provisionMember(HOUSEHOLD, '', member.pub, 'human', 'Aaron', null, BigInt(Date.now()))
const laptopDeleg = approvePairing(
  newPairingRequest(laptopPub, 'laptop'), member.pub, member.priv, BigInt(Date.now()))

localStorage.setItem('cairn-member-pub', b64(member.pub))
localStorage.setItem('cairn-device-sk', b64(laptopPriv))
localStorage.setItem('cairn-household-pub', b64(att.origin))
localStorage.setItem('cairn-attestation', JSON.stringify({}))  // shape unused here
const laptopSession = signSessionDelegation(
  sessionPub(), laptopPub, laptopPriv, 'chat', BigInt(Date.now() + 86_400_000))
for (const o of [att, laptopDeleg, laptopSession]) {
  await cairn.putIdentityObject({ cbor: enc(o) })
}

const stamp = Date.now().toString(36)
const spaceId = `sp-pair-${stamp}`
const roomId = `room-pair-${stamp}`
await cairn.sendEvent({ event: await buildSpaceCreate(spaceId, 'Pair Space') })
await cairn.sendEvent({ event: await buildSpaceMemberAdd(spaceId, member.pub, 'admin') })
await cairn.sendEvent({ event: await buildRoomCreate(roomId, 'Pair Room', spaceId) })
await cairn.sendEvent({ event: await buildMemberAdd(roomId, member.pub, 'admin', [], []) })
const earlyText = 'posted before the phone was paired'
await cairn.sendEvent({ event: await buildChat(roomId, { text: earlyText }, []) })
check('laptop holds the room key', haveRoomKey(roomId))

// --- phone: start pairing -------------------------------------------------
active = 'phone'
const pairing = beginDevicePairing('phone')
check('phone produced a pairing code', pairing.code.startsWith('cairn:pair:1:'))
check('pending pairing is resumable', pendingDevicePairing() !== null)

// --- laptop: scan + admit -------------------------------------------------
active = 'laptop'
const scanned = parsePairingRequest(pairing.code)
check('laptop parses the phone\'s code', hex(scanned.devicePub) === hex(pairing.devicePub))

const laptopIdentity = {
  memberPub: member.pub,
  devicePub: laptopPub,
  devicePriv: laptopPriv,
  householdPub: att.origin,
  attestation: att,
  delegation: laptopDeleg,
  displayName: 'Aaron',
  kind: 'human' as const,
  deviceLabel: 'laptop',
}
const phoneDeleg = admitDevice(laptopIdentity as any, scanned.devicePub, 'phone')
check('delegation names the phone', hex(phoneDeleg.device_pub) === hex(pairing.devicePub))
check('delegation parent is the LAPTOP, not the member root',
  hex(phoneDeleg.parent_pub) === hex(laptopPub))

// This is the step that was missing entirely before: publish it.
await cairn.putIdentityObject({ cbor: enc(phoneDeleg) })

// Carrier must now report the phone as one of this member's devices, or the
// re-wrap below has no target.
const devs = await cairn.listMemberDevices({ memberPub: member.pub })
check('carrier lists the phone under the member',
  devs.devicePubs.some((d) => hex(d) === hex(pairing.devicePub)),
  devs.devicePubs.map((d) => hex(d).slice(0, 12)).join(', '))

// --- laptop: re-wrap room keys to the new device --------------------------
const rotate = await buildRoomKeyRotate(roomId, [member.pub], [])
await cairn.sendEvent({ event: rotate })
const rotPayload = cborDecode(rotate.payload.subarray(1)) as any
check('rotation wraps to the phone',
  Object.keys(rotPayload.wrapped_keys ?? {}).includes(hex(pairing.devicePub)),
  Object.keys(rotPayload.wrapped_keys ?? {}).map((k) => k.slice(0, 12)).join(', '))

const afterText = 'posted after the phone was paired'
await cairn.sendEvent({ event: await buildChat(roomId, { text: afterText }, []) })

// --- phone: complete pairing, exactly as identity.pollPairing does --------
active = 'phone'
const resolved = await cairn.resolveSender({ senderPub: pairing.devicePub })
const chain = (resolved.deviceDelegations ?? []).map((b) => cborDecode(b) as DeviceDelegation)
check('resolveSender returns the phone\'s delegation chain', chain.length > 0,
  `${chain.length} link(s)`)
const attBack = resolved.attestation
  ? (cborDecode(resolved.attestation) as IdentityAttestation)
  : null
check('resolveSender returns the member attestation', attBack !== null)

let phoneIdentity: any = null
try {
  phoneIdentity = completeDevicePairing(chain, attBack!)
  check('phone completed pairing', true)
} catch (e) {
  check('phone completed pairing', false, e instanceof Error ? e.message : String(e))
}

if (phoneIdentity) {
  check('phone stored the member root it was attested under',
    hex(phoneIdentity.memberPub) === hex(member.pub))
  check('phone device key matches the one it generated',
    hex(phoneIdentity.devicePub) === hex(pairing.devicePub))
  check('loadIdentity() returns the paired identity', loadIdentity() !== null)

  // --- phone: sync and read ----------------------------------------------
  const sync = await cairn.sync({ roomId: new TextEncoder().encode(roomId), haveHeads: [] })
  console.log(`\n  phone synced ${sync.missing.length} events`)
  let applyErr = ''
  for (const ev of sync.missing) {
    if (!verifyEvent(ev)) {
      check('phone verifies synced events', false, `type ${ev.type} failed verifyEvent`)
      continue
    }
    try { await applyKeyEvent(ev) } catch (e) {
      applyErr = e instanceof Error ? e.message : String(e)
    }
  }
  check('phone holds a room key after syncing', haveRoomKey(roomId), applyErr)

  let sawAfter = false
  let sawEarly = false
  for (const ev of sync.missing) {
    const d = await openEvent(ev)
    if (d?.kind === 'chat') {
      if (d.text === afterText) sawAfter = true
      if (d.text === earlyText) sawEarly = true
    }
  }
  check('phone can read messages sent AFTER pairing', sawAfter)
  console.log(`  note  pre-pairing history readable: ${sawEarly} (not re-wrapped by design)`)
}

console.log(failures === 0 ? '\nPASS: device pairing works end to end' : `\nFAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

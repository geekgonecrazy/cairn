// END-TO-END agent story, running the REAL client code against a live cairnd.
//
// This is the proof for the agent-delegation slice (docs/adrs/0017): a human
// mints an agent with the EXACT calls the UI makes, hands it a bundle, a
// harness adopts it, it posts, and a peer resolves it as proven — then
// withdrawal un-proves it and transfer re-proves it elsewhere.
//
//   human: onboard (member + device + session, all published)
//   human: mint agent (UI-identical) -> vouch -> publish -> bundle
//   harness: parse bundle (validates) -> go run ./cmd/agent -adopt -> key file
//   human: create space + room, admit the agent, post
//   agent: sync, unwrap the room key, post
//   human: sync, read the agent's post, resolveSender -> PROVEN
//   human: withdraw the vouch -> UNPROVEN (still resolves)
//   agent: re-attest to a second human, who vouches -> PROVEN (new operator)
//
// Run against a live cairnd (fresh DB recommended):
//   npx tsx scripts/e2e-agent.ts
//   CAIRN_ADDR=http://192.168.1.10:8099 npx tsx scripts/e2e-agent.ts
//
// Two localStorage stores are swapped in and out to impersonate two clients in
// one process, because crypto.ts reads storage on every call rather than caching.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

const stores: Record<string, Record<string, string>> = {}
let active = 'human'

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
  if (input instanceof Request && input.url.startsWith('file://')) {
    const u = new URL(input.url)
    return realFetch(new Request(BASE + u.pathname, input as any), init)
  }
  return realFetch(input, init)
}) as typeof fetch

const {
  newMemberRoot,
  newSelfAttestation,
  verifyAttestation,
  newPairingRequest,
  approvePairing,
  signSessionDelegation,
  issueAgentVouch,
  withdrawVouch,
  verifyAgentDelegation,
  vouchWithdrawn,
  verifyDeviceDelegation,
  standaloneDeviceKey,
  encodeHandoffBundle,
  parseHandoffBundle,
  fingerprint,
  samePub,
} = await import('../src/lib/identity.ts')
const {
  buildSpaceCreate,
  buildSpaceMemberAdd,
  buildRoomCreate,
  buildMemberAdd,
  buildChat,
  applyKeyEvent,
  openEvent,
  verifyEvent,
  haveRoomKey,
  sessionPub,
} = await import('../src/lib/crypto.ts')
const { cairn, hex } = await import('../src/lib/api.ts')
const { encode: cborEncode, decode: cborDecode } = await import('../src/lib/cbor.ts')
const { ed25519 } = await import('@noble/curves/ed25519.js')

const rnd = (n: number) => {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function put(obj: unknown) {
  await cairn.putIdentityObject({ cbor: cborEncode(obj as any) })
}

console.log('e2e agent (real client code against a live cairnd)\n')

// --- human onboards: member + device + session, all published --------------
active = 'human'
const human = newMemberRoot()
const humanDevicePriv = rnd(32)
const humanDevicePub = ed25519.getPublicKey(humanDevicePriv)
// Exactly what vault.persist writes: crypto.ts reads the device identity from
// here whenever it wraps or unwraps a room key.
localStorage.setItem('cairn-member-pub', b64(human.keys.pub))
localStorage.setItem('cairn-device-sk', b64(humanDevicePriv))
const now0 = BigInt(Date.now())
await put(newSelfAttestation(human.keys, 'human', 'Sam', null, now0))
await put(approvePairing(newPairingRequest(humanDevicePub, 'browser'), human.keys.pub, human.keys.priv, now0))
await put(signSessionDelegation(sessionPub(), humanDevicePub, humanDevicePriv, 'chat', now0 + 86_400_000n))
console.log(`  human member ${hex(human.keys.pub).slice(0, 12)} device ${hex(humanDevicePub).slice(0, 12)}`)

// --- human mints an agent: the EXACT calls the UI makes (vault.mintAgent) --
const agent = newMemberRoot()
const agentDevice = standaloneDeviceKey(agent.keys.priv)
const agentName = 'Sous-chef'
const now1 = BigInt(Date.now())
const agentAtt = newSelfAttestation(agent.keys, 'agent', agentName, human.keys.pub, now1)
const agentDd = approvePairing(
  newPairingRequest(agentDevice.pub, agentName),
  agent.keys.pub,
  agent.keys.priv,
  now1,
)
const vouch = issueAgentVouch(agent.keys.pub, humanDevicePub, humanDevicePriv, human.keys.pub, now1)
await put(agentAtt)
await put(agentDd)
await put(vouch)
check('agent attestation + delegation + vouch published', true)

const info = await cairn.relayInfo({})
const bundle = encodeHandoffBundle({
  agent_seed: agent.keys.priv,
  relay_url: BASE,
  relay_pub: info.relayPub,
  invite: '',
  attestation: cborEncode(agentAtt as any),
  device_delegation: cborEncode(agentDd as any),
  vouch: cborEncode(vouch as any),
  agent_name: agentName,
})
check('bundle encodes', bundle.startsWith('cairn:agent:1:'))
const parsed = parseHandoffBundle(bundle)
check(
  'bundle parses and validates',
  hex(parsed.agent_seed) === hex(agent.keys.priv) && parsed.agent_name === agentName,
)
check(
  'harness derives the same device the UI delegated',
  hex(standaloneDeviceKey(parsed.agent_seed).pub) === hex(agentDevice.pub),
)

// --- harness adopts: go run ./cmd/agent -adopt ------------------------------
const keyDir = mkdtempSync(join(tmpdir(), 'cairn-e2e-agent-'))
const keyPath = join(keyDir, 'agent.key')
const adopted = spawnSync('go', ['run', './cmd/agent', '-adopt', bundle, '-keys', keyPath], {
  cwd: REPO,
  encoding: 'utf-8',
})
check('cmd/agent -adopt exits 0', adopted.status === 0, (adopted.stderr || '').trim().slice(0, 200))
const keyBytes = readFileSync(keyPath)
check(
  'adopted key file holds the agent root',
  keyBytes.length === 64 && hex(keyBytes.subarray(0, 32)) === hex(agent.keys.priv),
  `len=${keyBytes.length}`,
)
check(
  'adopt prints the agent member pub',
  ((adopted.stdout || '') + (adopted.stderr || '')).includes(hex(agent.keys.pub).slice(0, 12)),
)

// --- human creates a space + room and admits the agent -----------------------
const stamp = Date.now().toString(36)
const spaceId = `sp-e2eagent-${stamp}`
const roomId = `room-e2eagent-${stamp}`
active = 'human'
await cairn.sendEvent({ event: await buildSpaceCreate(spaceId, 'Agent E2E') })
await cairn.sendEvent({ event: await buildSpaceMemberAdd(spaceId, human.keys.pub, 'admin') })
await cairn.sendEvent({ event: await buildRoomCreate(roomId, 'Agent Room', spaceId) })
await cairn.sendEvent({
  event: await buildMemberAdd(roomId, human.keys.pub, 'admin', [], []),
})
check('human holds the room key', haveRoomKey(roomId))

await cairn.sendEvent({
  event: await buildMemberAdd(roomId, agent.keys.pub, 'member', [human.keys.pub], []),
})

// --- agent syncs, unwraps, posts ----------------------------------------------
active = 'agent'
localStorage.setItem('cairn-member-pub', b64(agent.keys.pub))
localStorage.setItem('cairn-device-sk', b64(agentDevice.priv))
// The agent's session: same shape as a browser tab's (sessionPub auto-mints
// per store slot), delegated under the agent's DERIVED device key.
const agentSessionPub = sessionPub()
await put(
  signSessionDelegation(agentSessionPub, agentDevice.pub, agentDevice.priv, 'chat', BigInt(Date.now() + 86_400_000)),
)
const sync = await cairn.sync({ roomId: new TextEncoder().encode(roomId), haveHeads: [] })
let applied = 0
for (const ev of sync.missing) {
  if (!verifyEvent(ev)) {
    check('agent verifies every synced event', false, `type ${ev.type}`)
    continue
  }
  try {
    if (await applyKeyEvent(ev)) applied++
  } catch (e) {
    check('agent applies key events', false, e instanceof Error ? e.message : String(e))
  }
}
check('agent unwrapped the room key', haveRoomKey(roomId), `applied=${applied}`)

const agentText = 'dinner is at seven, and I booked the table'
await cairn.sendEvent({ event: await buildChat(roomId, { text: agentText }, []) })
check('agent posted as itself', true)

// --- human reads the post and resolves the agent as PROVEN -------------------
active = 'human'
const sync2 = await cairn.sync({ roomId: new TextEncoder().encode(roomId), haveHeads: [] })
let sawAgentPost = false
let agentSender: Uint8Array | null = null
for (const ev of sync2.missing) {
  if (!verifyEvent(ev)) continue
  try {
    await applyKeyEvent(ev)
  } catch {
    /* epochs we already hold */
  }
  const d = await openEvent(ev)
  if (d?.kind === 'chat' && (d as any).text === agentText) {
    sawAgentPost = true
    agentSender = (ev as any).senderPub as Uint8Array
  }
}
check('human reads the agent post', sawAgentPost)
check('agent post is signed by the agent device', !!agentSender && hex(agentSender) === hex(agentSessionPub))

// The proof, computed from ResolveSender bytes with the same rules as the
// app's directory (verify everything, trust nothing handed over).
async function proofFor(devicePub: Uint8Array) {
  const res: any = await cairn.resolveSender({ senderPub: devicePub })
  const att: any = cborDecode(res.attestation)
  if (!verifyAttestation(att) || att.kind !== 'agent' || hex(att.pubkey) !== hex(agent.keys.pub)) {
    return { proven: false, vouches: 0, why: 'bad attestation' }
  }
  const operator = att.operated_by as Uint8Array
  const now = BigInt(Date.now())
  const withdraws: any[] = (res.vouchWithdraws ?? []).map((b: Uint8Array) => cborDecode(b))
  let live = 0
  for (const b of res.agentDelegations ?? []) {
    const v: any = cborDecode(b)
    if (!verifyAgentDelegation(v)) continue
    if (!samePub(v.agent_pub, att.pubkey) || !samePub(v.operator_pub, operator)) continue
    if (v.expires_at !== undefined && v.expires_at !== 0n && now > v.expires_at) continue
    if (vouchWithdrawn(v, withdraws)) continue
    if (samePub(v.delegator_pub, operator)) {
      live++
      continue
    }
    // The delegator must be a live device in the operator's tree.
    const dr: any = await cairn.resolveSender({ senderPub: v.delegator_pub })
    const chain: any[] = (dr.deviceDelegations ?? []).map((x: Uint8Array) => cborDecode(x))
    const revokes: any[] = (dr.deviceRevokes ?? []).map((x: Uint8Array) => cborDecode(x))
    const byDevice = new Map(chain.map((d) => [hex(d.device_pub), d]))
    const path: any[] = []
    const seen = new Set<string>()
    let cur: Uint8Array = v.delegator_pub
    let okWalk = true
    for (let i = 0; i <= 8; i++) {
      const h = hex(cur)
      if (seen.has(h)) {
        okWalk = false
        break
      }
      seen.add(h)
      const dd = byDevice.get(h)
      if (!dd) break
      if (!verifyDeviceDelegation(dd) || hex(dd.device_pub) !== h) {
        okWalk = false
        break
      }
      path.push(dd)
      cur = dd.parent_pub
    }
    if (!okWalk || path.length === 0 || hex(cur) !== hex(operator)) continue
    let revoked = false
    for (let i = 0; i < path.length; i++) {
      const r = revokes.find((x: any) => hex(x.device_pub) === hex(path[i].device_pub))
      if (!r) continue
      const ancestors = [...path.slice(i + 1).map((d) => hex(d.device_pub)), hex(cur)]
      if (ancestors.includes(hex(r.revoker_pub))) {
        revoked = true
        break
      }
    }
    if (!revoked) live++
  }
  return { proven: live > 0, vouches: live, why: '', name: att.display_name, operator: hex(operator) }
}

const p1 = await proofFor(agentSessionPub)
check('agent resolves as PROVEN', p1.proven && p1.vouches === 1, JSON.stringify(p1))
check('proven operator is the human', (p1 as any).operator === hex(human.keys.pub))
check('proven name is the agent name', (p1 as any).name === agentName)

// --- human withdraws the vouch: UNPROVEN, still resolving ---------------------
active = 'human'
await put(withdrawVouch(agent.keys.pub, humanDevicePub, humanDevicePriv, BigInt(Date.now())))
const p2 = await proofFor(agentSessionPub)
check('after withdraw the agent is UNPROVEN', !p2.proven && p2.vouches === 0, JSON.stringify(p2))

// --- transfer: the agent re-attests to a second human, who vouches ------------
active = 'human2'
const human2 = newMemberRoot()
const human2DevicePriv = rnd(32)
const human2DevicePub = ed25519.getPublicKey(human2DevicePriv)
localStorage.setItem('cairn-member-pub', b64(human2.keys.pub))
localStorage.setItem('cairn-device-sk', b64(human2DevicePriv))
const now2 = BigInt(Date.now())
await put(newSelfAttestation(human2.keys, 'human', 'Pat', null, now2))
await put(approvePairing(newPairingRequest(human2DevicePub, 'tablet'), human2.keys.pub, human2.keys.priv, now2))
await put(signSessionDelegation(sessionPub(), human2DevicePub, human2DevicePriv, 'chat', now2 + 86_400_000n))

// The agent moves ITSELF: only its own key can change operated_by. The seed
// comes from the bundle — this is also the proof the bundle is sufficient.
const agentKeys = { pub: ed25519.getPublicKey(parsed.agent_seed), priv: parsed.agent_seed }
await put(newSelfAttestation(agentKeys, 'agent', agentName, human2.keys.pub, now2 + 1n))
await put(issueAgentVouch(agent.keys.pub, human2DevicePub, human2DevicePriv, human2.keys.pub, now2 + 1n))

const p3 = await proofFor(agentSessionPub)
check('after transfer the agent is PROVEN', p3.proven && p3.vouches === 1, JSON.stringify(p3))
check('operator moved, old vouch is void', (p3 as any).operator === hex(human2.keys.pub))

console.log(
  failures === 0
    ? '\nAGENT E2E PASS: mint -> bundle -> adopt -> post -> proven -> withdraw -> transfer'
    : `\n${failures} agent e2e failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)

// Stand up a demo room full of inlays, and admit a human member to it.
//
// Posts as a household-attested member rather than cmd/agent, because the agent
// founds its OWN standalone household — a carrier with trustedRoots pinned will
// refuse it (adoption is off once roots are configured). Everything here chains
// to the same household as the person being admitted.
//
// Run: npx tsx scripts/demo-inlays.ts "<household phrase>" <member-root-hex>

const stores: Record<string, Record<string, string>> = {}
let active = 'demo'
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
  if (input instanceof URL && input.protocol === 'file:') return realFetch(BASE + input.pathname, init)
  if (input instanceof Request && input.url.startsWith('file://')) {
    const u = new URL(input.url)
    return realFetch(new Request(BASE + u.pathname, input as any), init)
  }
  return realFetch(input, init)
}) as typeof fetch

const { memberRootFromMnemonic, provisionMember, approvePairing, newPairingRequest, signSessionDelegation } =
  await import('../src/lib/identity.ts')
const {
  buildSpaceCreate, buildSpaceMemberAdd, buildRoomCreate, buildMemberAdd,
  buildChat, buildInlay, buildInlayDecl, haveRoomKey, sessionPub,
} = await import('../src/lib/crypto.ts')
const { declHash } = await import('../src/lib/inlay/registry.ts')
const { cairn } = await import('../src/lib/api.ts')
const { encode: cborEncode } = await import('../src/lib/cbor.ts')

const HOUSEHOLD = process.argv[2]
const HUMAN_HEX = process.argv[3]
if (!HOUSEHOLD || !HUMAN_HEX) throw new Error('usage: demo-inlays.ts "<phrase>" <member-root-hex>')
const humanPub = Uint8Array.from(Buffer.from(HUMAN_HEX, 'hex'))
if (humanPub.length !== 32) throw new Error('member root must be 64 hex chars')

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

// A demo member of the SAME household, so its events pass the chain gate.
const DEMO_WORDS =
  'legal winner thank year wave sausage worth useful legal winner thank year ' +
  'wave sausage worth useful legal winner thank year wave sausage worth title'
const member = memberRootFromMnemonic(DEMO_WORDS)
const devicePriv = new Uint8Array(32)
crypto.getRandomValues(devicePriv)
const { ed25519 } = await import('@noble/curves/ed25519.js')
const devicePub = ed25519.getPublicKey(devicePriv)

const att = provisionMember(HOUSEHOLD, '', member.pub, 'human', 'Cairn Demo', null, BigInt(Date.now()))
const dd = approvePairing(newPairingRequest(devicePub, 'demo-device'), member.pub, member.priv, BigInt(Date.now()))
localStorage.setItem('cairn-member-pub', b64(member.pub))
localStorage.setItem('cairn-device-sk', b64(devicePriv))
const sd = signSessionDelegation(sessionPub(), devicePub, devicePriv, 'chat', BigInt(Date.now() + 86_400_000))
for (const o of [att, dd, sd]) await cairn.putIdentityObject({ cbor: cborEncode(o as any) })

const stamp = Date.now().toString(36)
const spaceId = `sp-inlays-${stamp}`
const roomId = `room-inlays-${stamp}`

await cairn.sendEvent({ event: await buildSpaceCreate(spaceId, 'Inlay Showcase') })
await cairn.sendEvent({ event: await buildSpaceMemberAdd(spaceId, member.pub, 'admin') })
// The human needs SPACE membership too, or the room never appears in their sidebar.
await cairn.sendEvent({ event: await buildSpaceMemberAdd(spaceId, humanPub, 'admin') })
await cairn.sendEvent({ event: await buildRoomCreate(roomId, 'inlays', spaceId) })
await cairn.sendEvent({ event: await buildMemberAdd(roomId, member.pub, 'admin', [], []) })
if (!haveRoomKey(roomId)) throw new Error('demo member did not get the room key')

// Admit the human WITH history, so everything below is readable even though it
// is posted after the add.
await cairn.sendEvent({
  event: await buildMemberAdd(roomId, humanPub, 'member', [member.pub], [], true),
})

await cairn.sendEvent({
  event: await buildChat(roomId, { text: 'Every inlay below is the SAME renderer walking a different declaration.' }, []),
})

// Every card below is published the NEW way: the declaration travels as an
// INLAY_DECL event and the client learns it by verified hash. None of these are
// compiled into the webapp any more — the shipped set is approval_prompt alone.
//
// They are defined here rather than imported because they now live in cmd/agent
// (Go). That duplication is deliberate and confined to this demo script: the
// point is to prove a client learns declarations it never shipped, and importing
// them from the app would quietly defeat that.

type Decl = Record<string, unknown>

const declPoll: Decl = {
  name: 'poll',
  version: 1,
  authorless: true,
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'question', emphasis: 'title' },
    children: [
      {
        role: 'list', bind: 'options', empty: 'No options.',
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

const declTaskList: Decl = {
  name: 'task_list',
  version: 1,
  bound_events: ['task_request', 'task_update'],
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'title', emphasis: 'title' },
    children: [
      {
        role: 'record', cols: 3,
        fields: [
          { key: 'Running', node: { role: 'number', bind: 'summary.running' } },
          { key: 'Queued', node: { role: 'number', bind: 'summary.queued' } },
          { key: 'Done today', node: { role: 'number', bind: 'summary.done' } },
        ],
      },
      {
        role: 'list', bind: 'tasks', empty: 'Nothing queued.',
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

// Composition by hash: the panel embeds the task list, so BOTH declarations must
// be published or the panel renders with a hole where the ref is.
const declAgentPanel: Decl = {
  name: 'agent_panel',
  version: 1,
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'agent', emphasis: 'title' },
    children: [
      { role: 'status_enum', bind: 'status' },
      { role: 'inlay_ref', decl_cid: declHash(declTaskList as never) },
      {
        role: 'group',
        header: { role: 'text', value: 'Capabilities', emphasis: 'note' },
        children: [
          {
            role: 'list', bind: 'capabilities', empty: 'No capabilities granted.',
            item: {
              role: 'group',
              children: [
                { role: 'text', bind: 'name' },
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

const declGreenhouse: Decl = {
  name: 'greenhouse_bench',
  version: 1,
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'title', emphasis: 'title' },
    children: [
      { role: 'timestamp', bind: 'updated_at' },
      { role: 'status_enum', bind: 'status' },
      {
        role: 'record', cols: 2,
        fields: [
          { key: 'Air temp', node: { role: 'number', bind: 'air_temp', unit: '\u00b0C', showTrend: true }, note: 'within 22\u201326\u00b0 band' },
          { key: 'Humidity', node: { role: 'number', bind: 'humidity', unit: '%', showTrend: true }, note: 'target 55\u201370%' },
          { key: 'Soil moisture', node: { role: 'number', bind: 'soil', unit: '%' }, note: 'beds nominal' },
          { key: 'CO\u2082', node: { role: 'number', bind: 'co2', unit: 'ppm' }, note: 'day cycle' },
        ],
      },
      { role: 'series', bind: 'air_series', polarity: 'positive', band: [22, 26], label: 'Air temp \u00b7 last 6h' },
    ],
  },
  actions: [
    { id: 'refresh', label: 'Refresh', kind: 'immediate', variant: 'ghost' },
    { id: 'vent', label: 'Open roof vent', kind: 'immediate', capability_request: 'vent.actuate(gh_roof)', scope: '30 min \u00b7 this vent only' },
  ],
}

const declWellPump: Decl = {
  name: 'well_pump_cycle',
  version: 1,
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'title', emphasis: 'title' },
    children: [
      { role: 'status_enum', bind: 'state' },
      {
        role: 'record', cols: 2,
        fields: [
          { key: 'Pressure', node: { role: 'number', bind: 'psi', unit: 'psi' } },
          { key: 'Duty cycle', node: { role: 'progress_fraction', bind: 'duty' } },
        ],
      },
      { role: 'series', bind: 'psi_series', polarity: 'positive', band: [35, 55], label: 'Pressure \u00b7 last hour' },
    ],
  },
  actions: [{ id: 'prime', label: 'Prime pump', kind: 'immediate', variant: 'primary' }],
}

const now = Date.now()
const cards: { decl: Decl; text: string; bindings: Record<string, unknown>; widget?: unknown }[] = [
  {
    decl: declPoll,
    text: 'Poll: Saturday work party \u2014 morning (3), afternoon (5), skip (1).',
    bindings: {
      question: 'Saturday work party \u2014 when?',
      options: [
        { label: 'Morning', share: 0.33 },
        { label: 'Afternoon', share: 0.56 },
        { label: 'Skip this week', share: 0.11 },
      ],
    },
  },
  {
    decl: declTaskList,
    text: 'agent: 1 running, 1 queued, 2 done today.',
    bindings: {
      title: 'cmd/agent \u2014 task queue',
      summary: { running: 1, queued: 1, done: 2 },
      tasks: [
        { name: 'Fold room state', status: { label: 'running', polarity: 'busy' }, progress: 0.72 },
        { name: 'Enforce chain gate', status: { label: 'queued', polarity: 'neutral' }, progress: 0 },
      ],
    },
  },
  {
    decl: declAgentPanel,
    text: 'cmd/agent \u2014 online. Capabilities: rooms.write (auto), keys.rotate (human-gated).',
    bindings: {
      agent: 'cmd/agent',
      status: { label: 'online', polarity: 'positive' },
      title: 'cmd/agent \u2014 task queue',
      summary: { running: 1, queued: 1, done: 2 },
      tasks: [{ name: 'Fold room state', status: { label: 'running', polarity: 'busy' }, progress: 0.72 }],
      capabilities: [
        { name: 'rooms.write', policy: { label: 'auto', polarity: 'positive' } },
        { name: 'keys.rotate', policy: { label: 'human-gated', polarity: 'busy' } },
        { name: 'device.revoke', policy: { label: 'forbidden', polarity: 'negative' } },
      ],
    },
  },
  {
    decl: declGreenhouse,
    text: 'Greenhouse east bench \u2014 24.6\u00b0C, 61% humidity, soil 34%, CO\u2082 640ppm. Nominal.',
    bindings: {
      title: 'Greenhouse \u2014 east bench',
      updated_at: now - 4 * 60 * 1000,
      status: { label: 'nominal', polarity: 'positive' },
      air_temp: { value: 24.6, delta: 0.2, trend: 'up' },
      humidity: { value: 61, delta: 1, trend: 'down' },
      soil: 34,
      co2: 640,
      air_series: [23.1, 23.4, 23.2, 23.8, 24.2, 24.0, 24.5, 24.3, 24.6, 24.4, 24.6, 24.5],
    },
  },
  {
    decl: declWellPump,
    text: 'Well pump \u2014 running, 41 psi, 36% duty.',
    bindings: {
      title: 'Well pump \u2014 south field',
      state: { label: 'running', polarity: 'positive' },
      psi: 41,
      duty: 0.36,
      psi_series: [38, 39, 41, 42, 41, 40, 41, 43, 41],
    },
  },
]

// 1. Publish every declaration first, so the room looks right on first render.
for (const c of cards) {
  await cairn.sendEvent({ event: await buildInlayDecl(roomId, c.decl, []) })
  console.log(`  declared ${c.decl.name} (${declHash(c.decl as never).slice(0, 8)})`)
}

// 2. Then an instance of each.
for (const c of cards) {
  await cairn.sendEvent({
    event: await buildInlay(
      roomId,
      { decl_cid: declHash(c.decl as never), surface: 'timeline', text: c.text, bindings: c.bindings } as never,
      [],
    ),
  })
  console.log(`  posted   ${c.decl.name}`)
}

// 3. The widget escape hatch: never renders inline, placeholder + Open. It rides
//    on a declaration like anything else, but the widget ref is what the UI keys on.
await cairn.sendEvent({
  event: await buildInlay(
    roomId,
    {
      decl_cid: declHash(declGreenhouse as never),
      surface: 'timeline',
      text: 'Greenhouse camera \u2014 live view (opens sandboxed).',
      widget: { component_hash: 'demo-widget-placeholder', hint: { width: 320, height: 180 } },
    } as never,
    [],
  ),
})
console.log('  posted   widget placeholder')

console.log(`\nspace: ${spaceId}\nroom:  ${roomId}\nadmitted: ${hex(humanPub).slice(0, 16)}…`)

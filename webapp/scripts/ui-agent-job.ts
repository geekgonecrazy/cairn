// The whole agent story, end to end, in a real browser:
//
//   agent asks to join -> operator attests it as kind=agent -> agent posts an
//   approval request -> a HUMAN clicks Approve -> agent starts the job and
//   repaints one card with inlay_update checkpoints -> the human sees progress
//   advance.
//
// This exists because the declaration path was browser-verified but the UPDATE
// path was only typechecked. "The card posts but the bar never moves" is exactly
// the kind of failure that survives a typecheck and every tsx test, because the
// fold that applies checkpoints lives in a runes file.
//
// Run: npx tsx scripts/ui-agent-job.ts "<household phrase>"

import { chromium, type Browser, type Page } from 'playwright'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOUSEHOLD = process.argv[2]
if (!HOUSEHOLD) throw new Error('pass the household recovery phrase as argv[2]')
const BASE = process.env.CAIRN_ADDR ?? 'https://127.0.0.1:8099'
const APP = `${BASE}/__hub/`
const REPO = '..'
const CERT = '/root/code/cairn/tls/dev-cert.pem'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const go = (args: string[], env: Record<string, string> = {}) =>
  execFileSync('go', args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env } })

function wire(page: Page, who: string) {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      console.log(`    [${who} ${m.type()}] ${m.text().slice(0, 300)}`)
    }
  })
  page.on('pageerror', (e) => console.log(`    [${who} pageerror] ${String(e).slice(0, 200)}`))
}

async function joinHousehold(page: Page, name: string) {
  await page.goto(APP)
  await page.getByRole('button', { name: 'Join a household' }).first().click()
  await page.getByPlaceholder('Sam', { exact: true }).fill(name)
  await page.getByRole('button', { name: /Get my join code/i }).click()

  const words: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.words li')).map(
      (li) => (li.textContent ?? '').replace(/^\s*\d+\s*/, '').trim()))
  if (words.length !== 24) throw new Error(`expected 24 words, saw ${words.length}`)
  await page.getByRole('button', { name: /written it down/i }).click()

  const labels = await page.locator('label.field span').allTextContents()
  const inputs = page.locator('label.field input')
  const n = await inputs.count()
  for (let i = 0; i < n; i++) {
    const idx = Number((labels[i] ?? '').replace(/\D/g, '')) - 1
    await inputs.nth(i).fill(words[idx])
  }
  await page.getByRole('button', { name: /Finish setup/i }).click()
  await page.waitForTimeout(500)
  return (await page.locator('code').first().innerText()).trim()
}

async function acceptInvite(page: Page, invite: string) {
  await page.locator('textarea').last().fill(invite)
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /It matches — join/i }).click()
  await page.waitForTimeout(2000)
}

/** Pull the cairn:att: line out of cairnctl's output. */
const inviteFrom = (out: string) => {
  const line = out.split('\n').find((l) => l.startsWith('cairn:att:'))
  if (!line) throw new Error(`no invite in output:\n${out}`)
  return line.trim()
}

const browser: Browser = await chromium.launch()
console.log('UI test: agent asks, human approves, card updates\n')

const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await ctx.newPage()
wire(page, 'human')

// --- 1. a human joins the household --------------------------------------
const humanCode = await joinHousehold(page, 'Operator')
await acceptInvite(page, inviteFrom(
  go(['run', './cmd/cairnctl', 'attest', '-phrase', HOUSEHOLD, humanCode])))
const humanRoot: string = await page.evaluate(() => {
  const b64 = localStorage.getItem('cairn-member-pub') ?? ''
  return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
})
check('human is in the app', humanRoot.length === 64, humanRoot.slice(0, 16))

// --- 2. the agent asks to join, the operator attests it as an AGENT -------
const keyDir = mkdtempSync(join(tmpdir(), 'cairn-agent-'))
const keyPath = join(keyDir, 'agent.key')
const firstRun = go(['run', './cmd/agent', '-keys', keyPath, '-name', 'Job Agent'])
const joinCode = (firstRun.match(/cairn:join:[^\s"]+[^"\s]*/) ?? [])[0]?.replace(/"$/, '') ?? ''
check('agent printed a join code', joinCode.startsWith('cairn:join:'), joinCode.slice(0, 28))

const agentInvite = inviteFrom(go([
  'run', './cmd/cairnctl', 'attest', '-phrase', HOUSEHOLD,
  '-kind', 'agent', '-operated-by', humanRoot, joinCode,
]))
check('operator attested it as kind=agent', agentInvite.startsWith('cairn:att:'))

// --- 3. the agent runs against OUR household, no second root pinned -------
const roomName = `job-${Date.now().toString(36)}`
const agent = spawn('go', [
  'run', './cmd/agent',
  '-keys', keyPath, '-name', 'Job Agent', '-server', BASE,
  '-member', humanRoot, '-room', roomName, '-live', '-invite', agentInvite,
], { cwd: REPO, env: { ...process.env, SSL_CERT_FILE: CERT } })

let agentLog = ''
agent.stdout.on('data', (b) => { agentLog += String(b) })
agent.stderr.on('data', (b) => { agentLog += String(b) })

for (let i = 0; i < 60 && !agentLog.includes('waiting for a human'); i++) {
  await page.waitForTimeout(1000)
}
check('agent published under our household', agentLog.includes('attested into household'),
  (agentLog.match(/attested into household \w+ as "[^"]+"/) ?? [''])[0])
check('agent is waiting for approval', agentLog.includes('waiting for a human'))

// --- 4. the human finds the request and approves it -----------------------
await page.reload()
await page.waitForTimeout(4000)
await page.getByText(roomName, { exact: false }).first().click().catch(() => {})
await page.waitForTimeout(2500)

const beforeBody = (await page.locator('body').textContent()) ?? ''
check('approval request is visible', beforeBody.includes('vent.actuate'),
  beforeBody.includes('vent.actuate') ? 'vent.actuate(gh_roof)' : 'not found')

await page.getByRole('button', { name: /Approve/i }).first().click()
await page.waitForTimeout(3000)
check('grant was signed and sent', !!(await page.locator('body').textContent())?.includes('approved')
  || agentLog.includes('approved'), '')

// What key material does the client actually hold for this room? A grant the
// agent cannot open means the two sides disagree about the key, and this says
// which epoch the browser sealed with.
const keyState = await page.evaluate((room: string) => {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) ?? ''
    if (k.includes(room) && (k.startsWith('cairn-rk:') || k.startsWith('cairn-epoch:'))) {
      out.push(`${k}=${(localStorage.getItem(k) ?? '').slice(0, 12)}`)
    }
  }
  return out.join('  ')
}, roomName)
console.log(`  client key state: ${keyState}`)

// --- 5. the job card appears and then UPDATES ------------------------------
for (let i = 0; i < 30 && !agentLog.includes('inlay(agent_job)'); i++) {
  await page.waitForTimeout(1000)
}
await page.waitForTimeout(3000)
const atStart = (await page.locator('body').textContent()) ?? ''
check('job card posted', atStart.includes('Indexing the greenhouse archive'))

// The panel surface: standing furniture beside the room, NOT a timeline row.
const panelCount = await page.locator('aside.room-panel').count()
check('room panel is rendered', panelCount === 1, `${panelCount} panel(s)`)
// The agent must still be IN the room. A client enforces "channel roster ⊆ space
// roster", so an agent that created a space without joining it gets evicted from
// its own room and locked out of the next key epoch.
const declDenied = (await page.locator('body').textContent() ?? '').includes('declaration not allowed')
check('agent was not evicted (its declarations render)', !declDenied,
  declDenied ? 'declarations refused — agent is not in the roster' : 'trust-by-author applied')
const panelText = panelCount ? ((await page.locator('aside.room-panel').textContent()) ?? '') : ''
check('panel hosts the agent status card', panelText.includes('Greenhouse Agent'),
  panelText.slice(0, 60).replace(/\s+/g, ' '))
// If it also appeared as a message, the surface routing is not doing its job.
const bodyText = (await page.locator('.room-body').textContent()) ?? ''
check('panel inlay is NOT in the timeline',
  !bodyText.includes('Waiting for something to do'),
  bodyText.includes('Waiting for something to do') ? 'it leaked into the timeline' : 'timeline clean')

// Wait for checkpoints to land. Each step is 12s apart; watch for the last one.
for (let i = 0; i < 90 && !agentLog.includes('job complete'); i++) {
  await page.waitForTimeout(1000)
}
await page.waitForTimeout(3000)
const atEnd = (await page.locator('body').textContent()) ?? ''

check('agent finished the job', agentLog.includes('job complete'))
console.log('\n  --- agent log tail ---')
console.log(agentLog.split('\n').slice(-8).map((l) => `  ${l}`).join('\n'))
// The point of the whole exercise: ONE card whose bindings moved, not a stack
// of status messages.
check('card advanced past its starting step',
  !atEnd.includes('Waiting for the first batch'),
  atEnd.includes('Waiting for the first batch') ? 'still showing the initial binding' : 'bindings changed')
check('card shows the final step', atEnd.includes('1,120 files indexed'),
  atEnd.includes('1,120 files indexed') ? 'done' : 'final checkpoint not applied')
// The panel must track the job, not stay frozen at its initial binding.
const panelEnd = (await page.locator('aside.room-panel').textContent().catch(() => '')) ?? ''
check('panel followed the job to completion',
  panelEnd.includes('idle') && !panelEnd.includes('Verifying checksums'),
  panelEnd.replace(/\s+/g, ' ').slice(0, 70))
check('panel was not duplicated by its checkpoints',
  (panelEnd.match(/Greenhouse Agent/g) ?? []).length <= 1,
  `${(panelEnd.match(/Greenhouse Agent/g) ?? []).length} copies`)

check('card was not duplicated per update',
  (atEnd.match(/Indexing the greenhouse archive/g) ?? []).length === 1,
  `${(atEnd.match(/Indexing the greenhouse archive/g) ?? []).length} copies`)

// Distinguish "never arrived" from "arrived but did not render": if a reload
// shows what the live session did not, the transport is fine and the fold is
// not being re-run.
const liveHadCard = atEnd.includes('Indexing the greenhouse archive')
const liveHadFinal = atEnd.includes('1,120 files indexed')
await page.reload()
await page.waitForTimeout(5000)
await page.getByText(roomName, { exact: false }).first().click().catch(() => {})
await page.waitForTimeout(3000)
const afterReload = (await page.locator('body').textContent()) ?? ''
console.log(`\n  live: card=${liveHadCard} final=${liveHadFinal}`)
console.log(`  after reload: card=${afterReload.includes('Indexing the greenhouse archive')} ` +
  `final=${afterReload.includes('1,120 files indexed')}`)

await page.screenshot({ path: '/tmp/ui-agent-job.png', fullPage: true })
console.log('\n  screenshot: /tmp/ui-agent-job.png')

agent.kill()
await browser.close()
console.log(failures === 0 ? '\nPASS: agent asked, human approved, card updated in place' : `\nFAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

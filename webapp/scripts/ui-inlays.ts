// Do agent-published inlays actually RENDER in the real client?
//
// The library tests prove a declaration can be learned and resolved, but they
// call learnDeclaration directly. The app learns it during the fold, where the
// author must be resolved for trust-by-author to allow it — a step no tsx test
// can reach, because state.svelte.ts is a runes file. That gap is exactly where
// this broke: declarations were learned authorless, so every card degraded to
// its text line and the room looked empty.
//
// Run: npx tsx scripts/ui-inlays.ts "<household phrase>"

import { chromium, type Browser, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'

const HOUSEHOLD = process.argv[2]
if (!HOUSEHOLD) throw new Error('pass the household recovery phrase as argv[2]')
const BASE = process.env.CAIRN_ADDR ?? 'https://127.0.0.1:8099'
const APP = `${BASE}/__hub/`

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function attest(joinCode: string): string {
  const out = execFileSync(
    'go',
    ['run', './cmd/cairnctl', 'attest', '-phrase', HOUSEHOLD, joinCode],
    { cwd: '..', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const line = out.split('\n').find((l) => l.startsWith('cairn:att:'))
  if (!line) throw new Error(`no invite in cairnctl output:\n${out}`)
  return line.trim()
}

function wire(page: Page, who: string) {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`    [${who} console.error] ${m.text().slice(0, 200)}`)
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

  // The quiz asks for three positions by number.
  const labels = await page.locator('label.field span').allTextContents()
  const inputs = page.locator('label.field input')
  const n = await inputs.count()
  for (let i = 0; i < n; i++) {
    const idx = Number((labels[i] ?? '').replace(/\D/g, '')) - 1
    await inputs.nth(i).fill(words[idx])
  }
  await page.getByRole('button', { name: /Finish setup/i }).click()
  await page.waitForTimeout(500)

  const code = await page.locator('code').first().innerText()
  return code.trim()
}

async function acceptInvite(page: Page, invite: string) {
  await page.locator('textarea').last().fill(invite)
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /It matches — join/i }).click()
  await page.waitForTimeout(2000)
}

const browser: Browser = await chromium.launch()
console.log('UI test: do agent-published inlays render?\n')

const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await ctx.newPage()
wire(page, 'tester')

const code = await joinHousehold(page, 'Tester')
check('tester got a join code', code.startsWith('cairn:join:'))
await acceptInvite(page, attest(code))

const memberHex: string = await page.evaluate(() => {
  const b64 = localStorage.getItem('cairn-member-pub') ?? ''
  const bin = atob(b64)
  return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
})
check('tester is in the app', memberHex.length === 64, memberHex.slice(0, 16))

// Publish a room full of runtime-declared inlays TO this member.
const out = execFileSync(
  'npx',
  ['tsx', 'scripts/demo-inlays.ts', HOUSEHOLD, memberHex],
  { encoding: 'utf8', env: { ...process.env, CAIRN_ADDR: BASE, NODE_TLS_REJECT_UNAUTHORIZED: '0' } },
)
const roomLine = out.split('\n').find((l) => l.startsWith('room:')) ?? ''
console.log(`  ${roomLine.trim()}`)

// Reload so the client syncs the new space, then open it.
await page.reload()
await page.waitForTimeout(3000)
await page.getByText('inlays', { exact: false }).first().click().catch(() => {})
await page.waitForTimeout(3000)

const body = (await page.locator('body').textContent()) ?? ''

// The declarations were never compiled into this client: it shipped only
// approval_prompt. Anything below therefore arrived as an INLAY_DECL event.
check('poll rendered', body.includes('Saturday work party'), '')
check('task_list rendered', body.includes('task queue'), '')
check('agent_panel rendered', body.includes('rooms.write'), '')
check('greenhouse rendered', body.includes('east bench'), '')
check('well_pump rendered', body.includes('south field'), '')

// The real regression signal: a card that resolved but was refused renders the
// text line plus this note. Its absence is what "trust-by-author works" means.
check('no declaration was refused', !body.includes('declaration not allowed'),
  body.includes('declaration not allowed') ? 'trust-by-author did not apply' : 'none refused')
check('no declaration was unresolvable', !body.includes('declaration unavailable'),
  body.includes('declaration unavailable') ? 'a decl_cid never resolved' : 'all resolved')

await page.screenshot({ path: '/tmp/ui-inlays.png', fullPage: true })
console.log('\n  screenshot: /tmp/ui-inlays.png')
await browser.close()
console.log(failures === 0 ? '\nPASS: agent-published inlays render in the real client' : `\nFAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

// Drive the REAL UI in a real browser: two users, a channel, messages, then a
// second device for one of them.
//
// The library-level e2e tests all pass, which means any remaining bug lives in
// the Svelte orchestration — the layer those tests cannot reach because runes
// files don't run under tsx. So: actual clicks, actual localStorage, actual
// component state.
//
// Run:  npx tsx scripts/ui-pairing.ts "<household phrase>"

import { chromium, type Browser, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'

const HOUSEHOLD = process.argv[2]
if (!HOUSEHOLD) throw new Error('pass the household recovery phrase as argv[2]')
const BASE = process.env.CAIRN_ADDR ?? 'http://127.0.0.1:8099'
const APP = `${BASE}/__hub/`

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Attest a join code with cairnctl, exactly as the operator would. */
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

/** Surface anything the page logs, so a silent client error becomes visible. */
function wire(page: Page, who: string) {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`    [${who} console.error] ${m.text().slice(0, 200)}`)
  })
  page.on('pageerror', (e) => console.log(`    [${who} pageerror] ${String(e).slice(0, 200)}`))
}

/** Take a user through Join a household -> phrase -> confirm -> join code. */
async function joinHousehold(page: Page, name: string) {
  await page.goto(APP)
  await page.getByRole('button', { name: 'Join a household' }).first().click()
  await page.getByPlaceholder('Sam', { exact: true }).fill(name)
  await page.getByRole('button', { name: /Get my join code/i }).click()

  // Read the phrase BEFORE leaving the screen that shows it.
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

/** Paste the invite and land in the app. */
async function acceptInvite(page: Page, invite: string) {
  await page.locator('textarea').last().fill(invite)
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /It matches — join/i }).click()
  await page.waitForTimeout(1500)
}

const browser: Browser = await chromium.launch()
console.log('UI test: two users, a channel, then a second device\n')

async function setUp(page: Page, who: string, name: string) {
  wire(page, who)
  const code = await joinHousehold(page, name)
  await acceptInvite(page, attest(code))
  const onboarding = await page.locator('h1', { hasText: 'Join a household' }).count()
  check(`${who} is in the app`, onboarding === 0)
}

// --- 1. two users join ----------------------------------------------------
const aaronCtx = await browser.newContext()
const aaron = await aaronCtx.newPage()
await setUp(aaron, 'aaron', 'Aaron')

const joeCtx = await browser.newContext()
const joe = await joeCtx.newPage()
await setUp(joe, 'joe', 'Joe')

// --- 2. aaron creates a space and a channel ------------------------------
await aaron.getByRole('button', { name: /Create a space|New space|\+/ }).first().click()
await aaron.waitForTimeout(400)
await aaron.locator('input').first().fill('Home')
await aaron.getByRole('button', { name: /Create/i }).last().click()
await aaron.waitForTimeout(1200)
await aaron.screenshot({ path: '/tmp/ui-space.png' })
check('aaron created a space', (await aaron.locator('.err-banner').count()) === 0,
  await aaron.locator('.err-banner').first().innerText().catch(() => ''))

// --- 3. aaron creates a channel ------------------------------------------
await aaron.getByRole('button', { name: 'Create a channel' }).click()
await aaron.waitForTimeout(400)
await aaron.getByPlaceholder('Channel name').fill('general')
await aaron.getByRole('button', { name: /Create/i }).last().click()
await aaron.waitForTimeout(1500)
let banner = await aaron.locator('.err-banner').first().innerText().catch(() => '')
check('aaron created a channel', banner === '', banner)
await aaron.screenshot({ path: '/tmp/ui-channel.png' })

// --- 4. aaron posts ------------------------------------------------------
const MSG1 = 'hello from aaron'
await aaron.locator('textarea, [contenteditable="true"]').last().fill(MSG1)
await aaron.keyboard.press('Enter')
await aaron.waitForTimeout(1200)
check('aaron sees his own message', (await aaron.getByText(MSG1).count()) > 0)

// --- 5. aaron adds joe ---------------------------------------------------
const joeMemberKey: string = await joe.evaluate(() => {
  const b64 = localStorage.getItem('cairn-member-pub') ?? ''
  const bin = atob(b64)
  return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
})
check('read joe\'s member key from his browser', joeMemberKey.length === 64, joeMemberKey.slice(0, 16))

await aaron.locator('button[title*="ember"], button[aria-label*="ember"]').first().click()
  .catch(() => {})
await aaron.waitForTimeout(500)
await aaron.locator('#peer').fill(joeMemberKey)
await aaron.getByRole('button', { name: /^Add/i }).first().click()
await aaron.waitForTimeout(2000)
banner = await aaron.locator('.err-banner').first().innerText().catch(() => '')
check('aaron added joe without error', banner === '', banner)
await aaron.screenshot({ path: '/tmp/ui-added-joe.png' })
await aaron.keyboard.press('Escape')

const MSG2 = 'aaron after adding joe'
await aaron.locator('textarea, [contenteditable="true"]').last().fill(MSG2)
await aaron.keyboard.press('Enter')
await aaron.waitForTimeout(1500)

// --- 6. joe reads --------------------------------------------------------
await joe.reload()
await joe.waitForTimeout(2500)
await joe.locator('.room-row, .room, li').filter({ hasText: 'general' }).first().click()
  .catch(() => {})
await joe.waitForTimeout(2500)
await joe.screenshot({ path: '/tmp/ui-joe-room.png' })
const joeSeesMsg = (await joe.getByText(MSG2).count()) > 0
const joeBanner = await joe.locator('.err-banner').first().innerText().catch(() => '')
check('JOE can read the channel', joeSeesMsg, joeBanner || (await joe.locator('h2').first().innerText().catch(() => '')))

// --- 7. aaron pairs a phone ---------------------------------------------
const phoneCtx = await browser.newContext()
const phone = await phoneCtx.newPage()
wire(phone, 'phone')
await phone.goto(APP)
await phone.getByRole('button', { name: /Add this device to my account/i }).click()
await phone.waitForTimeout(800)
const pairCode = (await phone.locator('code').first().innerText()).trim()
check('phone shows a pairing code', pairCode.startsWith('cairn:pair:'), pairCode.slice(0, 30))

// Close the members modal via its own close control; Escape and scrim clicks
// were leaving the scrim mounted and swallowing every later click.
await aaron.getByRole('button', { name: /^Close$/i }).first().click().catch(() => {})
await aaron.waitForTimeout(500)
await aaron.locator('.scrim').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
await aaron.getByRole('button', { name: 'Identity and devices' }).click({ force: true })
await aaron.locator('h2', { hasText: 'Identity & devices' }).waitFor({ timeout: 10000 })
await aaron.getByRole('button', { name: /^Pair$/ }).click()
await aaron.waitForTimeout(500)
await aaron.locator('summary').filter({ hasText: /paste the code/i }).click()
await aaron.waitForTimeout(300)
await aaron.getByPlaceholder('cairn:pair:1:…').fill(pairCode)
await aaron.waitForTimeout(800)
await aaron.screenshot({ path: '/tmp/ui-pair-modal.png' })
await aaron.getByRole('button', { name: /They match — pair it/i }).click()
await aaron.waitForTimeout(4000)
await aaron.screenshot({ path: '/tmp/ui-paired.png' })
const pairBanner = await aaron.locator('.err-banner').first().innerText().catch(() => '')
check('aaron paired the phone without error', pairBanner === '', pairBanner)

// --- 8. the phone should land in the app and read ------------------------
await phone.waitForTimeout(6000)
await phone.screenshot({ path: '/tmp/ui-phone-after-pair.png' })
const phoneOnboarding = await phone.locator('h1', { hasText: /Show this to a device/i }).count()
check('phone completed pairing and left the waiting screen', phoneOnboarding === 0)

await phone.locator('.room-row, .room, li').filter({ hasText: 'general' }).first().click()
  .catch(() => {})
await phone.waitForTimeout(3000)
await phone.screenshot({ path: '/tmp/ui-phone-room.png' })

const MSG3 = 'aaron after pairing the phone'
await aaron.keyboard.press('Escape')
await aaron.locator('textarea, [contenteditable="true"]').last().fill(MSG3)
await aaron.keyboard.press('Enter')
await aaron.waitForTimeout(3000)

await phone.waitForTimeout(2000)
await phone.screenshot({ path: '/tmp/ui-phone-final.png' })
const phoneBanner = await phone.locator('.err-banner').first().innerText().catch(() => '')
const phoneSees = (await phone.getByText(MSG3).count()) > 0
check('PHONE can read the channel', phoneSees,
  phoneBanner || (await phone.locator('h2').first().innerText().catch(() => '')))

console.log('\n  (stopping here — screenshots in /tmp/ui-*.png)')
await aaron.screenshot({ path: '/tmp/ui-aaron-final.png' })
await joe.screenshot({ path: '/tmp/ui-joe-final.png' })

console.log(failures === 0 ? '\nPASS so far' : `\nFAIL: ${failures}`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)

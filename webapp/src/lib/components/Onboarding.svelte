<script lang="ts">
  // First-run onboarding: create a household (and record its 24 words) or
  // recover an existing one. Gated and unskippable — the recovery phrase is
  // shown exactly once and cannot be re-derived from Cairn afterwards, so the
  // confirm step verifies the human actually wrote it down (MILESTONES Phase 4).
  import QRCode from 'qrcode'
  import Icon from '../Icon.svelte'
  import { identity } from '../identity.svelte'
  import {
    beginJoin,
    completeJoin,
    pendingJoin,
    cancelJoin,
    beginDevicePairing,
    pendingDevicePairing,
    cancelDevicePairing,
    type Identity,
  } from '../vault'
  import { validateMnemonicPhrase, MNEMONIC_WORDS, parseAttestation, fingerprint } from '../identity'

  let { onready }: { onready: (id: Identity) => void } = $props()

  type Step =
    | 'welcome' | 'phrase' | 'confirm' | 'recover'
    | 'join' | 'join-wait' | 'found' | 'pair-wait'
  // A household is founded ONCE. Resume a join if one is already in flight,
  // otherwise start at the path most people actually need: joining.
  let step = $state<Step>(pendingJoin() ? 'join-wait' : 'welcome')

  let joinName = $state('')
  let joinCode = $state(pendingJoin()?.code ?? '')
  let inviteBlob = $state('')
  let joinError = $state('')
  let inviteHouseholdFp = $state('')
  let inviteFrom = $state('')

  let displayName = $state('')
  let deviceLabel = $state(defaultDeviceLabel())
  let mnemonic = $state('')
  // Held in MEMORY until the phrase is confirmed. Nothing is written to storage
  // before `commit` — persisting at mint time meant a reload on the phrase
  // screen dropped the user into a working app having never confirmed (or read)
  // the words, which are then gone for good since they are never stored.
  let pendingIdentity: Identity | null = null
  let pendingCommit: (() => void) | null = null

  // Confirm step: re-enter three words chosen at random from the phrase. Every
  // member has exactly one phrase — their own. The household's lives with
  // whoever runs the server and is never shown here.
  let quizPurpose = $state<'household' | 'member' | 'join'>('household')
  let quizIndexes = $state<number[]>([])
  let quizAnswers = $state<string[]>(['', '', ''])
  let quizError = $state('')

  // Recovery step.
  let recoveryPhrase = $state('')
  let recoveryHouseholdPhrase = $state('')
  let recoveryPassphrase = $state('')
  let recoveryName = $state('')
  let recoveryError = $state('')
  let busy = $state(false)

  // --- pairing this device onto an existing account ------------------------

  let pairCode = $state('')
  let pairQrUrl = $state('')
  let pairFingerprint = $state('')
  let pairError = $state('')
  let pairTimer: ReturnType<typeof setInterval> | null = null

  function startDevicePairing() {
    pairError = ''
    const res = beginDevicePairing(deviceLabel.trim() || 'this browser')
    pairCode = res.code
    pairFingerprint = fingerprint(res.devicePub)
    void QRCode.toDataURL(pairCode, { width: 220, margin: 1 })
      .then((u) => (pairQrUrl = u))
      .catch(() => (pairQrUrl = '')) // the text code below still works
    step = 'pair-wait'
    startPolling()
  }

  /**
   * Watch for the approval to land. Polling rather than pushing because this
   * device has no identity yet — it cannot open an authenticated stream, and the
   * carrier has nothing to push to. Every 2s is well inside human patience for a
   * flow where someone is tapping "approve" on another screen.
   */
  function startPolling() {
    stopPolling()
    pairTimer = setInterval(async () => {
      try {
        const id = await identity.pollPairing()
        if (id) {
          stopPolling()
          onready(id)
        }
      } catch (e) {
        // A malformed or mismatched approval needs a human, not another retry.
        stopPolling()
        pairError = e instanceof Error ? e.message : String(e)
      }
    }, 2000)
  }

  function stopPolling() {
    if (pairTimer) clearInterval(pairTimer)
    pairTimer = null
  }

  function abandonDevicePairing() {
    stopPolling()
    cancelDevicePairing()
    pairCode = ''
    pairQrUrl = ''
    pairError = ''
    step = 'welcome'
  }

  // Resume a pairing that was already in flight when the tab reloaded.
  $effect(() => {
    const pending = pendingDevicePairing()
    if (pending && step === 'welcome' && !pendingJoin()) {
      pairCode = pending.code
      pairFingerprint = fingerprint(pending.devicePub)
      void QRCode.toDataURL(pending.code, { width: 220, margin: 1 })
        .then((u) => (pairQrUrl = u))
        .catch(() => (pairQrUrl = ''))
      step = 'pair-wait'
      startPolling()
    }
    return stopPolling
  })

  function defaultDeviceLabel(): string {
    const ua = navigator.userAgent
    if (/iPhone|iPad/.test(ua)) return 'iPhone'
    if (/Android/.test(ua)) return 'Android phone'
    if (/Mac/.test(ua)) return 'Mac'
    if (/Windows/.test(ua)) return 'Windows PC'
    return 'this browser'
  }

  const words = $derived(mnemonic ? mnemonic.split(' ') : [])

  function checkQuiz() {
    const ok = quizIndexes.every(
      (wordIdx, i) => quizAnswers[i].trim().toLowerCase() === words[wordIdx],
    )
    if (!ok) {
      quizError = "That doesn't match. Check your written copy — order matters."
      return
    }
      // Confirmed: only NOW does anything reach storage.
    if (!pendingCommit) return
    pendingCommit()
    if (quizPurpose === 'join') {
      // The join is only half done — the newcomer still needs an attestation
      // from someone who holds the household words.
      step = 'join-wait'
      return
    }
    if (pendingIdentity) onready(pendingIdentity)
  }

  async function doRecover() {
    recoveryError = ''
    const bad = validateMnemonicPhrase(recoveryPhrase)
    if (bad) {
      recoveryError = bad
      return
    }
    busy = true
    try {
      // One path for everyone: re-derive the member root from these words and
      // pair it with the attestation published when this member joined. There is
      // no household-phrase branch on purpose — those words belong on the server,
      // and asking for them here would undo the reason attestation moved to the CLI.
      onready(
        await identity.recoverFromCarrier(
          recoveryPhrase,
          deviceLabel.trim() || 'this browser',
        ),
      )
    } catch (e) {
      recoveryError = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  function startJoin() {
    joinError = ''
    if (!joinName.trim()) {
      joinError = 'Enter the name your household will know you by.'
      return
    }
    // A joiner gets their OWN recovery phrase — they never see the household's.
    // It derives their member root, which signs this device's delegation and is
    // then dropped, so it must be written down here or it is gone.
    const res = beginJoin(joinName.trim(), deviceLabel.trim() || 'this browser')
    joinCode = res.code
    pendingCommit = res.commit
    mnemonic = res.memberMnemonic
    quizPurpose = 'join'
    startQuiz()
    step = 'phrase'
  }

  /** What the phrase on screen is FOR — they are not interchangeable. */
  const phraseTitle = 'Your personal recovery phrase'
  const phraseStepOf = ''

  /** Pick three distinct positions, sorted so prompts read in phrase order. */
  function startQuiz() {
    const picks = new Set<number>()
    while (picks.size < 3) picks.add(Math.floor(Math.random() * MNEMONIC_WORDS))
    quizIndexes = [...picks].sort((a, b) => a - b)
    quizAnswers = ['', '', '']
    quizError = ''
  }

  /**
   * Inspect the invite BEFORE accepting it. An attestation's `origin` is
   * self-declared: a household that isn't yours signs with its own root and the
   * signature verifies perfectly. A newcomer has no trusted root yet, so there
   * is no cryptographic way to tell the difference — the human must compare the
   * household fingerprint out-of-band, exactly as device pairing does.
   */
  function inspectInvite() {
    joinError = ''
    inviteHouseholdFp = ''
    inviteFrom = ''
    if (!inviteBlob.trim()) return
    try {
      const att = parseAttestation(inviteBlob)
      inviteHouseholdFp = fingerprint(att.origin)
      inviteFrom = att.display_name
    } catch (e) {
      joinError = e instanceof Error ? e.message : String(e)
    }
  }

  function finishJoin() {
    joinError = ''
    try {
      onready(completeJoin(inviteBlob))
    } catch (e) {
      joinError = e instanceof Error ? e.message : String(e)
    }
  }

  function abandonJoin() {
    cancelJoin()
    joinCode = ''
    inviteBlob = ''
    joinError = ''
    step = 'welcome'
  }

  async function copyText(s: string) {
    try {
      await navigator.clipboard.writeText(s)
    } catch {
      /* clipboard blocked; the text is on screen */
    }
  }

  async function copyPhrase() {
    try {
      await navigator.clipboard.writeText(mnemonic)
    } catch {
      /* clipboard blocked; the words are on screen to copy by hand */
    }
  }
</script>

<div class="wrap">
  <div class="card">
    {#if step === 'welcome'}
      <div class="mark"><Icon name="house" size={22} /></div>
      <h1>Set up Cairn</h1>
      <p class="lede">
        Cairn has no accounts and no server to sign in to. Your identity is a key that lives
        on your devices — you create it here, and it's yours.
      </p>
      <div class="actions col">
        <button class="primary" onclick={() => (step = 'join')}>
          Join a household
        </button>
        <button class="ghost" onclick={startDevicePairing}>
          Add this device to my account
        </button>
        <button class="ghost" onclick={() => (step = 'recover')}>
          Restore from my recovery phrase
        </button>
      </div>
      <p class="footnote">
        Everyone joins — including whoever set the household up. Founding it is a one-time
        <code>cairnctl init</code> on the server.
        <button class="link" onclick={() => (step = 'found')}>
          Nobody has set ours up yet
        </button>
      </p>

    {:else if step === 'pair-wait'}
      <h1>Show this to a device you already use</h1>
      <p class="lede">
        Open <strong>Identity &amp; devices → Pair</strong> there and scan this code. Check the
        fingerprint below matches what that device shows before approving — that comparison is
        the only thing standing between you and someone else's code.
      </p>
      {#if pairQrUrl}
        <img class="qr" src={pairQrUrl} alt="Pairing QR code for this device" />
      {/if}
      <code class="code">{pairCode}</code>
      <p class="fp-line">
        Fingerprint <span class="mono">{pairFingerprint}</span>
      </p>
      <p class="footnote">
        Waiting for approval… this screen updates itself. Nothing is shared with the other
        device except this public key — no recovery phrase is involved.
      </p>
      {#if pairError}<p class="error" role="alert">{pairError}</p>{/if}
      <div class="actions">
        <button class="ghost" onclick={abandonDevicePairing}>Cancel</button>
      </div>

    {:else if step === 'found'}
      <h1>Founding happens on the server</h1>
      <p class="lede">
        A household is created with the <code>cairnctl</code> command on the machine running
        Cairn, not in the browser. Two reasons: the household's 24 words are the most powerful
        secret in the system — they can vouch for anyone as anyone — and they should never be
        typed into a web page. And founding decides what the server trusts, which is server
        configuration.
      </p>
      <p class="lede">On that machine, run:</p>
      <code class="code">cairnctl init -name "Our household"</code>
      <p class="lede">
        It shows the phrase once, writes the household root to the server's trusted list, and
        tells you to restart Cairn. Then come back here and <strong>join</strong> — everyone
        joins, including whoever founded it.
      </p>
      <div class="actions">
        <button class="primary" onclick={() => (step = 'join')}>Join a household</button>
      </div>

    {:else if step === 'join'}
      <h1>Join a household</h1>
      <p class="lede">
        You'll get a join code to send to someone already in the household. They approve it and
        send back an invite — no password, and nothing secret travels either way.
      </p>
      <label class="field">
        <span>Your name</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          bind:value={joinName}
          placeholder="Sam"
          maxlength="64"
          onkeydown={(e) => e.key === 'Enter' && startJoin()}
        />
      </label>
      <label class="field">
        <span>Name for this device</span>
        <input bind:value={deviceLabel} placeholder="Sam's laptop" maxlength="64" />
      </label>
      {#if joinError}<p class="error" role="alert">{joinError}</p>{/if}
      <div class="actions">
        <button class="ghost" onclick={() => (step = 'welcome')}>Back</button>
        <button class="primary" onclick={startJoin}>Get my join code</button>
      </div>

    {:else if step === 'join-wait'}
      <h1>Send this to your household</h1>
      <p class="lede">
        Give this code to someone already in the household. In Cairn they open
        <strong>Identity &amp; devices → Members → Add someone</strong>, paste it, and send you
        back an invite.
      </p>
      <code class="code">{joinCode}</code>
      <div class="actions" style="margin-bottom:18px">
        <button class="ghost" onclick={() => copyText(joinCode)}>Copy join code</button>
      </div>

      <label class="field">
        <span>Paste the invite they send back</span>
        <textarea
          bind:value={inviteBlob}
          rows="3"
          placeholder="cairn:att:1:…"
          spellcheck="false"
          autocapitalize="none"
          oninput={inspectInvite}
        ></textarea>
      </label>

      {#if inviteHouseholdFp}
        <div class="verify">
          <div class="small muted">This invite is for <strong>{inviteFrom}</strong>, from household</div>
          <div class="mono big">{inviteHouseholdFp}</div>
          <p class="small muted" style="margin:8px 0 0">
            Ask the person who sent it to read out their household fingerprint
            (<strong>Identity &amp; devices → You → Household</strong>). If it doesn't match
            these characters exactly, this invite is from a different household — don't accept it.
          </p>
        </div>
      {/if}

      {#if joinError}<p class="error" role="alert">{joinError}</p>{/if}
      <div class="actions">
        <button class="ghost" onclick={abandonJoin}>Cancel</button>
        <button class="primary" disabled={!inviteHouseholdFp} onclick={finishJoin}>
          It matches — join
        </button>
      </div>

    {:else if step === 'phrase'}
      {#if phraseStepOf}<p class="step-of">Phrase {phraseStepOf}</p>{/if}
      <h1>{phraseTitle}</h1>

      <p class="lede">
        This is <strong>your</strong> phrase. It restores your account on a new device, and it
        is the only way to revoke a device you can no longer get to. It is not the household's
        phrase — that one lives on the server with whoever runs it, and you never need it.
      </p>
      <p class="lede">
        Losing a phone is ordinary, so keep this somewhere you can actually reach.
      </p>
      <p class="lede">
        Cairn does not store it and <strong>cannot show it to you again</strong>. Write it on
        paper — a photo or a password manager is a copy someone else can reach.
      </p>
      <ol class="words">
        {#each words as w, i}
          <li><span class="n">{i + 1}</span>{w}</li>
        {/each}
      </ol>
      <div class="actions">
        <button class="ghost" onclick={copyPhrase}>Copy</button>
        <button class="primary" onclick={() => (step = 'confirm')}>I've written it down</button>
      </div>

    {:else if step === 'confirm'}
      <h1>Check your copy</h1>
      <p class="lede">
        Type these three words from <strong>{phraseTitle.toLowerCase()}</strong> — the phrase you
        just wrote down{phraseStepOf ? ` (${phraseStepOf})` : ''}.
      </p>
      {#each quizIndexes as wordIdx, i}
        <label class="field">
          <span>Word {wordIdx + 1}</span>
          <input
            bind:value={quizAnswers[i]}
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            onkeydown={(e) => e.key === 'Enter' && checkQuiz()}
          />
        </label>
      {/each}
      {#if quizError}<p class="error" role="alert">{quizError}</p>{/if}
      <div class="actions">
        <button class="ghost" onclick={() => (step = 'phrase')}>Show the words again</button>
        <button class="primary" onclick={checkQuiz}>Finish setup</button>
      </div>

    {:else if step === 'recover'}
      <h1>Restore your account</h1>
      <p class="lede">
        Enter <strong>your personal recovery phrase</strong> — the one that is yours, not the
        household's. This restores the same account on this device, so rooms and rosters still
        know you. It does <strong>not</strong> bring back message history: room keys were never
        in any phrase, and past messages stay unreadable until someone re-admits you.
      </p>
      <label class="field">
        <span>Your personal recovery phrase</span>
        <textarea
          bind:value={recoveryPhrase}
          rows="3"
          placeholder="word one, word two, …"
          autocapitalize="none"
          spellcheck="false"
        ></textarea>
      </label>

      <details class="adv">
        <summary>I founded this household (I have its phrase too)</summary>
        <p class="hint">
          Only the founder holds the household phrase. With it, this works completely offline;
          without it, your account is looked up on the server, where it was published when you
          joined.
        </p>
        <label class="field">
          <span>Household recovery phrase</span>
          <textarea
            bind:value={recoveryHouseholdPhrase}
            rows="3"
            placeholder="word one, word two, …"
            autocapitalize="none"
            spellcheck="false"
          ></textarea>
        </label>
        <label class="field">
          <span>Display name</span>
          <input bind:value={recoveryName} placeholder="Sam" maxlength="64" />
        </label>
        <label class="field">
          <span>Household passphrase</span>
          <input bind:value={recoveryPassphrase} type="password" autocomplete="off" />
          <small class="hint">
            A wrong passphrase doesn't error — it silently derives a different household that
            nobody recognises. Leave blank if you never set one.
          </small>
        </label>
      </details>
      {#if recoveryError}<p class="error" role="alert">{recoveryError}</p>{/if}
      <div class="actions">
        <button class="ghost" onclick={() => (step = 'welcome')}>Back</button>
        <button class="primary" disabled={busy} onclick={doRecover}>Recover</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .wrap {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    padding: 20px;
    overflow-y: auto;
    background: var(--bg);
  }
  .card {
    width: 100%;
    max-width: 520px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-4, 14px);
    padding: 28px;
    margin: auto;
  }
  .mark {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: var(--accent-soft-2, var(--surface-2));
    color: var(--accent, var(--text));
    margin-bottom: 14px;
  }
  h1 {
    font-size: 21px;
    font-weight: 650;
    margin: 0 0 8px;
    letter-spacing: -0.01em;
  }
  .lede {
    color: var(--text-3);
    font-size: 14px;
    line-height: 1.55;
    margin: 0 0 18px;
  }
  .field {
    display: block;
    margin-bottom: 14px;
  }
  .field > span {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-3);
    margin-bottom: 6px;
  }
  input,
  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 11px 12px;
    font: inherit;
    font-size: 15px; /* <16px triggers iOS zoom-on-focus */
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
  }
  input:focus,
  textarea:focus {
    outline: 2px solid var(--accent, #3b82f6);
    outline-offset: -1px;
  }
  textarea {
    resize: vertical;
    font-family: var(--font-mono, monospace);
  }
  .hint {
    display: block;
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-4, var(--text-3));
  }
  .adv {
    margin-bottom: 14px;
  }
  .adv summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--text-3);
    padding: 6px 0;
  }
  .words {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding: 14px;
    margin: 0 0 18px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    font-family: var(--font-mono, monospace);
    font-size: 13px;
  }
  .words li {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .words .n {
    color: var(--text-4, var(--text-3));
    font-size: 11px;
    min-width: 16px;
    text-align: right;
  }
  .error {
    color: var(--danger, #dc2626);
    font-size: 13px;
    margin: 0 0 12px;
  }
  .verify {
    margin-bottom: 14px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    background: var(--surface-2);
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
  .big {
    font-size: 18px;
    letter-spacing: 0.03em;
    margin-top: 4px;
  }
  .small {
    font-size: 12px;
    line-height: 1.55;
  }
  .muted {
    color: var(--text-3);
  }
  .step-of {
    margin: 0 0 4px;
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .qr {
    display: block;
    margin: 14px auto;
    width: 200px;
    height: 200px;
    image-rendering: pixelated;
    background: #fff;
    padding: 8px;
    border-radius: 8px;
  }
  .fp-line {
    margin-top: 10px;
    font-size: 13px;
    color: var(--text-3);
    text-align: center;
  }
  .footnote {
    margin: 18px 0 0;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-3);
  }
  .link {
    display: inline;
    padding: 0;
    min-height: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--accent, #2563eb);
    text-decoration: underline;
    cursor: pointer;
  }
  .code {
    display: block;
    padding: 10px;
    margin-bottom: 10px;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    word-break: break-all;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .actions.col {
    flex-direction: column;
  }
  button {
    padding: 11px 16px;
    font: inherit;
    font-size: 14px;
    font-weight: 550;
    border-radius: var(--r-2, 8px);
    cursor: pointer;
    min-height: 44px;
    border: 1px solid var(--border);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .primary {
    background: var(--accent, #2563eb);
    border-color: transparent;
    color: #fff;
  }
  .ghost {
    background: transparent;
    color: var(--text);
  }
  .ghost:hover:not(:disabled) {
    background: var(--surface-2);
  }

  @media (max-width: 560px) {
    .card {
      padding: 20px;
      border: 0;
    }
    .words {
      grid-template-columns: repeat(2, 1fr);
    }
    .actions {
      flex-direction: column-reverse;
    }
    .actions button {
      width: 100%;
    }
  }
</style>

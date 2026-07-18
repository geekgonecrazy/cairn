<script lang="ts">
  // First-run onboarding: create a household (and record its 24 words) or
  // recover an existing one. Gated and unskippable — the recovery phrase is
  // shown exactly once and cannot be re-derived from Cairn afterwards, so the
  // confirm step verifies the human actually wrote it down (MILESTONES Phase 4).
  import Icon from '../Icon.svelte'
  import {
    bootstrap,
    recover,
    beginJoin,
    completeJoin,
    pendingJoin,
    cancelJoin,
    type Identity,
  } from '../vault'
  import { validateMnemonicPhrase, MNEMONIC_WORDS, parseAttestation, fingerprint } from '../identity'

  let { onready }: { onready: (id: Identity) => void } = $props()

  type Step = 'welcome' | 'name' | 'phrase' | 'confirm' | 'recover' | 'join' | 'join-wait' | 'found'
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
  let pendingIdentity: Identity | null = null

  // Confirm step: re-enter three words chosen at random from the phrase.
  let quizIndexes = $state<number[]>([])
  let quizAnswers = $state<string[]>(['', '', ''])
  let quizError = $state('')

  // Recovery step.
  let recoveryPhrase = $state('')
  let recoveryPassphrase = $state('')
  let recoveryName = $state('')
  let recoveryError = $state('')
  let busy = $state(false)

  function defaultDeviceLabel(): string {
    const ua = navigator.userAgent
    if (/iPhone|iPad/.test(ua)) return 'iPhone'
    if (/Android/.test(ua)) return 'Android phone'
    if (/Mac/.test(ua)) return 'Mac'
    if (/Windows/.test(ua)) return 'Windows PC'
    return 'this browser'
  }

  const words = $derived(mnemonic ? mnemonic.split(' ') : [])

  function createHousehold() {
    if (!displayName.trim()) return
    busy = true
    try {
      const res = bootstrap(displayName.trim(), deviceLabel.trim() || 'this browser')
      pendingIdentity = res.identity
      mnemonic = res.mnemonic
      // Three distinct positions, sorted so the prompts read in phrase order.
      const picks = new Set<number>()
      while (picks.size < 3) picks.add(Math.floor(Math.random() * MNEMONIC_WORDS))
      quizIndexes = [...picks].sort((a, b) => a - b)
      quizAnswers = ['', '', '']
      step = 'phrase'
    } finally {
      busy = false
    }
  }

  function checkQuiz() {
    const ok = quizIndexes.every(
      (wordIdx, i) => quizAnswers[i].trim().toLowerCase() === words[wordIdx],
    )
    if (!ok) {
      quizError = "That doesn't match. Check your written copy — order matters."
      return
    }
    if (pendingIdentity) onready(pendingIdentity)
  }

  function doRecover() {
    recoveryError = ''
    const bad = validateMnemonicPhrase(recoveryPhrase)
    if (bad) {
      recoveryError = bad
      return
    }
    if (!recoveryName.trim()) {
      recoveryError = 'Enter the name to use on this device.'
      return
    }
    busy = true
    try {
      onready(
        recover(
          recoveryPhrase,
          recoveryPassphrase,
          recoveryName.trim(),
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
    joinCode = beginJoin(joinName.trim(), deviceLabel.trim() || 'this browser')
    step = 'join-wait'
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
        <button class="ghost" onclick={() => (step = 'recover')}>
          Restore from my recovery phrase
        </button>
      </div>
      <p class="footnote">
        A household is created once, by whoever sets it up first — everyone else joins it.
        <button class="link" onclick={() => (step = 'found')}>
          Nobody has set ours up yet
        </button>
      </p>

    {:else if step === 'found'}
      <h1>Start a new household?</h1>
      <p class="lede">
        Only do this if your household doesn't exist yet. It creates a brand-new household
        with its own recovery phrase — it will <strong>not</strong> connect you to one that
        already exists. To join an existing household, go back and ask someone in it for an
        invite.
      </p>
      <div class="actions">
        <button class="ghost" onclick={() => (step = 'welcome')}>Back</button>
        <button class="primary" onclick={() => (step = 'name')}>
          Yes, start a new household
        </button>
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

    {:else if step === 'name'}
      <h1>What should people call you?</h1>
      <p class="lede">
        This name is signed into your identity and can't be changed later, so pick the one
        your household will recognise.
      </p>
      <label class="field">
        <span>Display name</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          bind:value={displayName}
          placeholder="Sam"
          maxlength="64"
          onkeydown={(e) => e.key === 'Enter' && createHousehold()}
        />
      </label>
      <label class="field">
        <span>Name for this device</span>
        <input bind:value={deviceLabel} placeholder="Sam's laptop" maxlength="64" />
      </label>
      <div class="actions">
        <button class="ghost" onclick={() => (step = 'welcome')}>Back</button>
        <button class="primary" disabled={!displayName.trim() || busy} onclick={createHousehold}>
          Continue
        </button>
      </div>

    {:else if step === 'phrase'}
      <h1>Write these 24 words down</h1>
      <p class="lede">
        This is the only way back into your household if you lose every device. Cairn does not
        store it and <strong>cannot show it to you again</strong>. Write it on paper — a photo
        or a password manager is a copy someone else can reach.
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
      <p class="lede">Type these three words from the phrase you just wrote down.</p>
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
      <h1>Recover your household</h1>
      <p class="lede">
        Enter your 24 words. This re-creates your identity under the same household — but it
        does <strong>not</strong> bring back message history: room keys were never in the phrase,
        and past messages stay unreadable until someone re-admits you.
      </p>
      <label class="field">
        <span>Recovery phrase</span>
        <textarea
          bind:value={recoveryPhrase}
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
      <details class="adv">
        <summary>I set a passphrase</summary>
        <label class="field">
          <span>Passphrase</span>
          <input bind:value={recoveryPassphrase} type="password" autocomplete="off" />
          <small class="hint">
            A wrong passphrase doesn't error — it silently creates a different household that
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

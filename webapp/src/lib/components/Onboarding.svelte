<script lang="ts">
  // First-run onboarding (v2 trust model): create a self-sovereign identity and
  // record its 24 words, add this device to an existing account, or restore from
  // a recovery phrase. There is no household to join — identity is a key you
  // create here (docs/decisions.md §Trust model v2). Gated and unskippable: the
  // recovery phrase is shown once and cannot be re-derived from Cairn, so the
  // confirm step verifies the human actually wrote it down.
  import QRCode from 'qrcode'
  import Icon from '../Icon.svelte'
  import { identity } from '../identity.svelte'
  import { cairn } from '../api'
  import {
    createIdentity,
    beginDevicePairing,
    pendingDevicePairing,
    cancelDevicePairing,
    type Identity,
  } from '../vault'
  import { validateMnemonicPhrase, MNEMONIC_WORDS, fingerprint } from '../identity'

  let { onready }: { onready: (id: Identity) => void } = $props()

  type Step = 'welcome' | 'create' | 'phrase' | 'confirm' | 'recover' | 'pair-wait'
  let step = $state<Step>('welcome')

  let displayName = $state('')
  let deviceLabel = $state(defaultDeviceLabel())
  let inviteCode = $state('')
  let createError = $state('')
  let mnemonic = $state('')
  // Held in MEMORY until the phrase is confirmed. Nothing is written to storage
  // before `commit` — persisting at mint time meant a reload on the phrase screen
  // dropped the user into a working app having never confirmed (or read) the
  // words, which are then gone for good since they are never stored.
  let pendingIdentity: Identity | null = null
  let pendingCommit: (() => void) | null = null

  // Confirm step: re-enter three words chosen at random from the phrase.
  let quizIndexes = $state<number[]>([])
  let quizAnswers = $state<string[]>(['', '', ''])
  let quizError = $state('')

  // Recovery step.
  let recoveryPhrase = $state('')
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
    if (pending && step === 'welcome') {
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

  function startCreate() {
    createError = ''
    if (!displayName.trim()) {
      createError = 'Enter the name people will know you by.'
      return
    }
    // Mint a member key from fresh words, self-attest a profile, and sign this
    // device's delegation — all held in memory until the words are confirmed.
    const res = createIdentity(displayName.trim(), deviceLabel.trim() || 'this browser')
    pendingIdentity = res.identity
    pendingCommit = res.commit
    mnemonic = res.memberMnemonic
    startQuiz()
    step = 'phrase'
  }

  async function checkQuiz() {
    const ok = quizIndexes.every(
      (wordIdx, i) => quizAnswers[i].trim().toLowerCase() === words[wordIdx],
    )
    if (!ok) {
      quizError = "That doesn't match. Check your written copy — order matters."
      return
    }
    if (!pendingCommit || !pendingIdentity) return
    // Confirmed: only NOW does anything reach storage.
    pendingCommit()
    // If an invite was supplied, redeem it so an invite-only relay admits us
    // before we start sending. Harmless on an open relay; a bad invite blocks
    // completion so the user can fix it rather than hit a wall of send errors.
    const invite = inviteCode.trim()
    if (invite) {
      try {
        await cairn.redeemInvite({ invite, memberPub: pendingIdentity.memberPub })
      } catch (e) {
        quizError = `That invite was refused: ${e instanceof Error ? e.message : String(e)}`
        return
      }
    }
    onready(pendingIdentity)
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
      // Re-derive the member key from these words and pair it with the
      // self-attestation this member published — looked up on the carrier.
      onready(
        await identity.recoverFromCarrier(recoveryPhrase, deviceLabel.trim() || 'this browser'),
      )
    } catch (e) {
      recoveryError = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  /** Pick three distinct positions, sorted so prompts read in phrase order. */
  function startQuiz() {
    const picks = new Set<number>()
    while (picks.size < 3) picks.add(Math.floor(Math.random() * MNEMONIC_WORDS))
    quizIndexes = [...picks].sort((a, b) => a - b)
    quizAnswers = ['', '', '']
    quizError = ''
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
        <button class="primary" onclick={() => (step = 'create')}>
          Create my identity
        </button>
        <button class="ghost" onclick={startDevicePairing}>
          Add this device to my account
        </button>
        <button class="ghost" onclick={() => (step = 'recover')}>
          Restore from my recovery phrase
        </button>
      </div>
      <p class="footnote">
        There's nothing to join and no invite to wait for — your identity is a key you own.
        People come to trust it when you pair with them or share a room.
      </p>

    {:else if step === 'create'}
      <h1>Create your identity</h1>
      <p class="lede">
        This mints a key that is yours. You'll get a recovery phrase to write down — it's the
        only way to restore this identity on another device.
      </p>
      <label class="field">
        <span>Your name</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          bind:value={displayName}
          placeholder="Sam"
          maxlength="64"
          onkeydown={(e) => e.key === 'Enter' && startCreate()}
        />
      </label>
      <label class="field">
        <span>Name for this device</span>
        <input bind:value={deviceLabel} placeholder="Sam's laptop" maxlength="64" />
      </label>
      <label class="field">
        <span>Invite code — only if the relay requires one</span>
        <input
          bind:value={inviteCode}
          placeholder="cairn:invite:1:…"
          spellcheck="false"
          autocapitalize="none"
        />
      </label>
      {#if createError}<p class="error" role="alert">{createError}</p>{/if}
      <div class="actions">
        <button class="ghost" onclick={() => (step = 'welcome')}>Back</button>
        <button class="primary" onclick={startCreate}>Create</button>
      </div>

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

    {:else if step === 'phrase'}
      <h1>Your recovery phrase</h1>
      <p class="lede">
        This restores your account on a new device, and it is the only way to revoke a device
        you can no longer get to. Losing a phone is ordinary, so keep this somewhere you can
        actually reach.
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
        Type these three words from your recovery phrase — the one you just wrote down.
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
        Enter <strong>your recovery phrase</strong>. This restores the same account on this
        device, so rooms and rosters still know you. It does <strong>not</strong> bring back
        message history: room keys were never in any phrase, and past messages stay unreadable
        until someone re-admits you.
      </p>
      <label class="field">
        <span>Your recovery phrase</span>
        <textarea
          bind:value={recoveryPhrase}
          rows="3"
          placeholder="word one, word two, …"
          autocapitalize="none"
          spellcheck="false"
        ></textarea>
      </label>
      <label class="field">
        <span>Name for this device</span>
        <input bind:value={deviceLabel} placeholder="Sam's laptop" maxlength="64" />
      </label>
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
  .mono {
    font-family: var(--font-mono, monospace);
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

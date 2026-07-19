<script lang="ts">
  // Identity & devices surface: who you are, what this device is, which other
  // devices you've admitted, and the QR pairing flow (MILESTONES Phase 4).
  import QRCode from 'qrcode'
  import Icon from '../Icon.svelte'
  import QrScanner from './QrScanner.svelte'
  import { identity } from '../identity.svelte'
  import {
    admitDevice,
    revokePeerDevice,
    peerDevices,
    subtreeOf,
    fingerprint,
    hex,
    type PeerDevice,
  } from '../vault'
  import {
    encodePairingRequest,
    newPairingRequest,
    parsePairingRequest,
  } from '../identity'
  import { app } from '../state.svelte'

  let { onclose }: { onclose: () => void } = $props()

  type Tab = 'identity' | 'members' | 'devices' | 'pair'
  let tab = $state<Tab>('identity')

  async function copy(s: string) {
    try {
      await navigator.clipboard.writeText(s)
    } catch {
      /* clipboard blocked; text is on screen */
    }
  }
  let devices = $state<PeerDevice[]>(peerDevices())
  let revokeError = $state('')
  let revokePublished = $state(false)
  let confirmReset = $state(false)
  let resetError = $state('')
  let resetting = $state(false)

  async function doReset() {
    resetError = ''
    resetting = true
    try {
      await identity.reset() // reloads on success
    } catch (e) {
      resetError = e instanceof Error ? e.message : String(e)
      resetting = false
    }
  }

  // Pairing: this device's own code (to be scanned BY a trusted device), and
  // the admit side (paste a code FROM a new device).
  let myCodeDataUrl = $state('')
  let pasted = $state('')
  let parsedFp = $state('')
  let parsedLabel = $state('')
  let pairError = $state('')
  let pairDone = $state('')
  let scanning = $state(false)
  let confirmRevoke = $state<PeerDevice | null>(null)

  const id = $derived(identity.current)

  const myPairingCode = $derived(
    id ? encodePairingRequest(newPairingRequest(id.devicePub, id.deviceLabel)) : '',
  )

  $effect(() => {
    if (tab !== 'pair' || !myPairingCode) return
    QRCode.toDataURL(myPairingCode, { width: 220, margin: 1 })
      .then((url) => (myCodeDataUrl = url))
      .catch(() => (myCodeDataUrl = '')) // fall back to the text code below
  })

  function inspect() {
    pairError = ''
    pairDone = ''
    parsedFp = ''
    parsedLabel = ''
    if (!pasted.trim()) return
    try {
      const req = parsePairingRequest(pasted)
      parsedFp = fingerprint(req.devicePub)
      parsedLabel = req.label
    } catch (e) {
      pairError = e instanceof Error ? e.message : String(e)
    }
  }

  async function confirmPair() {
    if (!id) return
    pairError = ''
    try {
      const req = parsePairingRequest(pasted)
      const delegation = admitDevice(id, req.devicePub, req.label || 'paired device')
      devices = peerDevices()

      // The delegation has to REACH the new device, which holds only its own
      // key and is polling the carrier for exactly this. Minting it locally and
      // stopping — which is what this did before — left the new device stuck on
      // its waiting screen forever.
      const published = await identity.publishObject(
        delegation as unknown as Record<string, unknown>,
      )
      if (!published) {
        pairError =
          `Approved on this device, but it could not be published — the new device is ` +
          `still waiting. Reconnect and use "Retry publishing".`
        return
      }
      // Also publish OUR attestation and chain, or the new device can verify the
      // delegation but cannot see what account it belongs to.
      await identity.publish()

      // Room keys seal to device keys, so the new device can read nothing until
      // each room we hold is rotated to include it. We can do this alone.
      pairDone = `Paired ${req.label || 'device'}. Sharing room keys…`
      const { rooms, failed } = await app.rewrapForNewDevice()
      pairDone =
        failed > 0
          ? `Paired ${req.label || 'device'}. Shared keys for ${rooms} room(s); ${failed} could ` +
            `not be shared — that device won't see those until you retry while online.`
          : `Paired ${req.label || 'device'}. It can now read ${rooms} room(s) going forward ` +
            `(not older messages).`
      pasted = ''
      parsedFp = ''
      parsedLabel = ''
    } catch (e) {
      pairError = e instanceof Error ? e.message : String(e)
    }
  }

  function onScanned(text: string) {
    scanning = false
    pasted = text.trim()
    inspect() // same untrusted-input path as a paste; the human still compares
  }

  /**
   * Devices that will ALSO stop working if `d` is revoked — everything paired
   * from it, at any depth. The cascade is automatic (a descendant's chain runs
   * through the revoked device), so it must be shown before confirming or it is
   * invisible until someone's other device silently dies.
   */
  /** Human name for the device (or member root) that admitted `d`. */
  function parentLabel(d: PeerDevice): string {
    if (!id) return 'unknown'
    const parent = hex(d.delegation.parent_pub)
    if (parent === hex(id.devicePub)) return `${id.deviceLabel} (this device)`
    if (parent === hex(id.memberPub)) return 'your recovery phrase'
    const p = devices.find((x) => hex(x.delegation.device_pub) === parent)
    return p ? p.label : `cairn:${parent.slice(0, 6)}`
  }

  function cascadeOf(d: PeerDevice): PeerDevice[] {
    const doomed = subtreeOf(d.delegation.device_pub).map(hex)
    return devices.filter(
      (x) =>
        !x.revoked &&
        hex(x.delegation.device_pub) !== hex(d.delegation.device_pub) &&
        doomed.includes(hex(x.delegation.device_pub)),
    )
  }

  async function revoke(d: PeerDevice) {
    if (!id) return
    revokeError = ''
    confirmRevoke = null
    const cascade = cascadeOf(d)
    const dr = revokePeerDevice(id, d.delegation.device_pub)
    devices = peerDevices()

    // Rotate every room we hold so the revoked device — and its whole subtree —
    // is excluded from the next epoch. Without this the revoke only stops them
    // SIGNING; they would keep reading, because they still hold the current key.
    let rotateNote = ''
    try {
      const { failed } = await app.rewrapForNewDevice()
      if (failed > 0) {
        rotateNote =
          ` ${failed} room(s) could not be re-keyed — that device can still read those ` +
          `until you retry while online.`
      }
    } catch {
      rotateNote = ' Rooms could not be re-keyed; that device can still read them for now.'
    }
    if (cascade.length) {
      pairDone =
        `Revoked ${d.label}, and with it ${cascade.length} device(s) it had admitted: ` +
        cascade.map((x) => x.label).join(', ') + '.'
    }

    // The local record is already updated — but until the signed revoke reaches
    // the carrier, every OTHER member still trusts this key. Say so plainly
    // rather than showing a reassuring "revoked" that isn't true for anyone else.
    const published = await identity.publishObject(dr as unknown as Record<string, unknown>)
    if (!published) {
      revokeError =
        `Revoked on this device, but it could not be published — other members will ` +
        `still accept "${d.label}" until you reconnect. Reopen this screen once you're online.` +
        rotateNote
    } else if (rotateNote) {
      revokeError = `Revocation published.${rotateNote}`
    }
  }

  /** Retry publishing revokes that never reached the carrier. */
  async function republishRevokes() {
    revokeError = ''
    let failed = 0
    for (const d of devices) {
      if (!d.revoked) continue
      const ok = await identity.publishObject(d.revoked as unknown as Record<string, unknown>)
      if (!ok) failed++
    }
    revokeError = failed
      ? `${failed} revocation(s) still could not be published — you may be offline.`
      : ''
    if (!failed) revokePublished = true
  }
</script>

<div
  class="scrim"
  role="button"
  tabindex="0"
  aria-label="Close"
  onclick={onclose}
  onkeydown={(e) => e.key === 'Escape' && onclose()}
></div>

<div class="modal" role="dialog" aria-modal="true" aria-label="Identity and devices">
  <header>
    <h2>Identity &amp; devices</h2>
    <button class="x" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
  </header>

  <nav class="tabs">
    <button class:on={tab === 'identity'} onclick={() => (tab = 'identity')}>You</button>
    <button class:on={tab === 'members'} onclick={() => (tab = 'members')}>Members</button>
    <button class:on={tab === 'devices'} onclick={() => (tab = 'devices')}>
      Devices{devices.length ? ` (${devices.length})` : ''}
    </button>
    <button class:on={tab === 'pair'} onclick={() => (tab = 'pair')}>Pair</button>
  </nav>

  <div class="body">
    {#if !id}
      <p class="muted">No identity on this device.</p>

    {:else if tab === 'identity'}
      <dl>
        <dt>Display name</dt>
        <dd>{id.displayName} <span class="tag">immutable</span></dd>
        <dt>Member key</dt>
        <dd>
          <!-- The FULL key, not its fingerprint: this is what someone pastes
               into "Add a member by key", so a truncated form is a dead end. -->
          <code class="keyval">{hex(id.memberPub)}</code>
          <button class="copy" onclick={() => copy(hex(id.memberPub))}>Copy member key</button>
          <div class="fp">fingerprint {fingerprint(id.memberPub)}</div>
        </dd>
        <dt>Household</dt>
        <dd class="mono">{fingerprint(id.householdPub)}</dd>
        <dt>This device</dt>
        <dd>{id.deviceLabel} · <span class="mono">{fingerprint(id.devicePub)}</span></dd>
      </dl>
      <p class="note">
        Your household root is not stored on this device — it exists only in your 24 words.
        Cairn cannot show them to you again.
      </p>

      <div class="danger">
        <h3>Reset this device</h3>
        {#if !confirmReset}
          <p class="muted">
            Erases this device's keys, its room keys, and its cached messages. There's no
            server session to sign out of — the keys are the account.
          </p>
          <div class="row">
            <button class="danger-btn wide" onclick={() => (confirmReset = true)}>
              Reset this device…
            </button>
          </div>
        {:else}
          <p class="muted">
            <strong>This cannot be undone.</strong>
          </p>
          <ul class="consequences">
            <li>
              Without your 24 words you lose this household — there is no other copy of
              your keys.
            </li>
            <li>
              Past messages stay unreadable even if you rejoin: room keys are destroyed and
              you'd be re-admitted at a new epoch.
            </li>
            <li>
              It revokes nothing. Other members keep trusting this device key until someone
              revokes it — and afterwards this device can't.
            </li>
          </ul>
          {#if resetError}<p class="error" role="alert">{resetError}</p>{/if}
          <div class="row two">
            <button class="ghost-btn" disabled={resetting} onclick={() => (confirmReset = false)}>
              Cancel
            </button>
            <button class="danger-btn" disabled={resetting} onclick={doReset}>
              {resetting ? 'Erasing…' : 'Erase everything'}
            </button>
          </div>
        {/if}
      </div>

    {:else if tab === 'members'}
      <section>
        <h3>Add someone to the household</h3>
        <p class="muted">
          Admitting a member is done on the server with <code>cairnctl</code>, not here. It
          needs the household's 24 words, and those should never be typed into a browser —
          they can vouch for anyone as anyone, and a web page is reachable by extensions,
          autofill and devtools history in a way a terminal is not.
        </p>
        <p class="muted">
          Ask them to open Cairn, choose <strong>Join a household</strong>, and send you the
          join code it shows. Then on the machine running Cairn:
        </p>
        <code class="code">cairnctl attest &lt;their join code&gt;</code>
        <p class="muted">
          It prints an invite to send back, and shows the household fingerprint they should
          see when they paste it — compare that out loud. An invite's origin is self-declared,
          so a stranger's household verifies its own signature perfectly; the fingerprint
          comparison is what actually distinguishes them.
        </p>
      </section>

    {:else if tab === 'devices'}
      {#if devices.length === 0}
        <p class="muted">
          No other devices paired yet. Use <strong>Pair</strong> to admit one.
        </p>
      {:else}
        <ul class="devices">
          {#each devices as d (hex(d.delegation.device_pub))}
            <li class:revoked={!!d.revoked}>
              <div class="d-main">
                <div class="d-name">
                  {d.label}
                  {#if d.revoked}<span class="tag danger">revoked</span>{/if}
                </div>
                <div class="mono small">{fingerprint(d.delegation.device_pub)}</div>
                <!-- Who admitted it. Devices pair devices, so this is the edge
                     that makes the cascade legible: revoking a parent revokes
                     everything under it. -->
                <div class="small muted">admitted by {parentLabel(d)}</div>
              </div>
              {#if !d.revoked}
                <button class="danger-btn" onclick={() => (confirmRevoke = d)}>Revoke</button>
              {/if}
            </li>
            {#if confirmRevoke && hex(confirmRevoke.delegation.device_pub) === hex(d.delegation.device_pub)}
              <li class="confirm-revoke">
                <p class="muted small">
                  <strong>Revoke {d.label}?</strong> This is permanent — a revoked key is
                  treated as compromised and can never be paired again.
                </p>
                {#if cascadeOf(d).length}
                  <p class="cascade" role="alert">
                    This also cuts off {cascadeOf(d).length} device(s) admitted from it:
                    <strong>{cascadeOf(d).map((x) => x.label).join(', ')}</strong>. They chain
                    through {d.label}, so they stop working too.
                  </p>
                {/if}
                <p class="muted small">
                  It keeps whatever it could already read; rooms are re-keyed so it reads
                  nothing new.
                </p>
                <div class="row two">
                  <button class="ghost-btn" onclick={() => (confirmRevoke = null)}>Cancel</button>
                  <button class="danger-btn" onclick={() => revoke(d)}>Revoke it</button>
                </div>
              </li>
            {/if}
          {/each}
        </ul>
        {#if revokeError}
          <p class="error" role="alert">{revokeError}</p>
          <div class="row">
            <button class="primary" onclick={republishRevokes}>Retry publishing</button>
          </div>
        {:else if revokePublished}
          <p class="ok" role="status">All revocations published to the household.</p>
        {/if}
        <p class="note">
          Revoking is permanent: a revoked key is treated as compromised and can never be
          paired again. Other members stop trusting it once the revocation reaches them.
        </p>
      {/if}

    {:else if tab === 'pair'}
      <section>
        <h3>Admit a device</h3>
        <p class="muted">
          Scan the QR code on the new device, or paste its pairing code. Compare the
          fingerprint on both screens before you confirm — that comparison is the whole
          security of pairing, since anyone can point a camera at anything.
        </p>

        {#if scanning}
          <QrScanner onscan={onScanned} oncancel={() => (scanning = false)} />
        {:else}
          <div class="row">
            <button class="primary" onclick={() => (scanning = true)}>
              <Icon name="camera" /> Scan QR code
            </button>
          </div>
          <details>
            <summary>Or paste the code</summary>
            <textarea
              bind:value={pasted}
              rows="3"
              placeholder="cairn:pair:1:…"
              spellcheck="false"
              autocapitalize="none"
              oninput={inspect}
            ></textarea>
          </details>
        {/if}
        {#if pairError}<p class="error" role="alert">{pairError}</p>{/if}
        {#if parsedFp}
          <div class="confirm">
            <div>
              <div class="small muted">Fingerprint on the new device must read</div>
              <div class="mono big">{parsedFp}</div>
              {#if parsedLabel}<div class="small muted">calls itself “{parsedLabel}”</div>{/if}
            </div>
            <button class="primary" onclick={confirmPair}>They match — pair it</button>
          </div>
        {/if}
        {#if pairDone}<p class="ok" role="status">{pairDone}</p>{/if}
      </section>

      <hr />

      <section>
        <h3>This device's code</h3>
        <p class="muted">Scan or copy this on a device that's already in your household.</p>
        {#if myCodeDataUrl}
          <img class="qr" src={myCodeDataUrl} alt="Pairing QR code for this device" />
        {/if}
        <code class="code">{myPairingCode}</code>
        <div class="fp-line">
          Fingerprint <span class="mono">{fingerprint(id.devicePub)}</span>
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgb(0 0 0 / 0.44);
    border: 0;
  }
  .modal {
    position: fixed;
    z-index: 61;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, calc(100vw - 32px));
    max-height: min(680px, calc(100dvh - 32px));
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-4, 14px);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    font-size: 15px;
    font-weight: 650;
    margin: 0;
  }
  h3 {
    font-size: 13px;
    font-weight: 650;
    margin: 0 0 6px;
  }
  .x {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    background: transparent;
    border: 0;
    color: var(--text-3);
    cursor: pointer;
    border-radius: var(--r-2, 8px);
  }
  .x:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 8px 12px 0;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    padding: 9px 12px;
    min-height: 44px;
    font: inherit;
    font-size: 13px;
    font-weight: 550;
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--text-3);
    cursor: pointer;
  }
  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--accent, #2563eb);
  }
  .body {
    padding: 16px;
    overflow-y: auto;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 8px 12px;
    font-size: 13px;
  }
  dt {
    color: var(--text-3);
  }
  dd {
    margin: 0;
    word-break: break-word;
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
  .keyval {
    display: block;
    padding: 8px;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    line-height: 1.5;
    word-break: break-all;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
  }
  .copy {
    margin-top: 6px;
    padding: 7px 10px;
    min-height: 36px;
    font: inherit;
    font-size: 12px;
    font-weight: 550;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    cursor: pointer;
  }
  .copy:hover { background: var(--surface-2); }
  .fp {
    margin-top: 6px;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--text-3);
  }
  .small {
    font-size: 12px;
  }
  .big {
    font-size: 17px;
    letter-spacing: 0.02em;
  }
  .muted {
    color: var(--text-3);
    font-size: 13px;
    line-height: 1.55;
  }
  .note {
    margin: 14px 0 0;
    padding: 10px 12px;
    background: var(--surface-2);
    border-radius: var(--r-2, 8px);
    font-size: 12px;
    line-height: 1.55;
    color: var(--text-3);
  }
  .tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .tag.danger {
    background: var(--danger-soft, #fee2e2);
    color: var(--danger, #b91c1c);
  }
  .devices {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .devices li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
  }
  .devices li.revoked {
    opacity: 0.55;
  }
  .devices li.confirm-revoke {
    display: block;
    background: var(--surface-2);
    border-color: var(--danger-soft, #fecaca);
  }
  .cascade {
    margin: 8px 0;
    padding: 10px 12px;
    border-radius: var(--r-2, 8px);
    background: var(--danger-soft, #fee2e2);
    color: var(--danger, #b91c1c);
    font-size: 12px;
    line-height: 1.55;
  }
  details {
    margin-top: 10px;
  }
  details summary {
    font-size: 12px;
    color: var(--text-3);
    cursor: pointer;
    min-height: 32px;
  }
  .d-name {
    font-size: 13px;
    font-weight: 550;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    margin-top: 8px;
    padding: 10px;
    font-family: var(--font-mono, monospace);
    font-size: 15px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    resize: vertical;
  }
  .confirm {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 10px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    background: var(--surface-2);
  }
  .qr {
    display: block;
    margin: 10px 0;
    width: 200px;
    height: 200px;
    image-rendering: pixelated;
    background: #fff;
    padding: 8px;
    border-radius: 8px;
  }
  .code {
    display: block;
    padding: 10px;
    font-size: 11px;
    word-break: break-all;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
  }
  .fp-line {
    margin-top: 8px;
    font-size: 12px;
    color: var(--text-3);
  }
  hr {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 18px 0;
  }
  button.primary {
    padding: 10px 14px;
    min-height: 44px;
    font: inherit;
    font-size: 13px;
    font-weight: 550;
    background: var(--accent, #2563eb);
    color: #fff;
    border: 0;
    border-radius: var(--r-2, 8px);
    cursor: pointer;
  }
  .danger-btn {
    padding: 8px 12px;
    min-height: 44px;
    font: inherit;
    font-size: 12px;
    font-weight: 550;
    background: transparent;
    color: var(--danger, #dc2626);
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    cursor: pointer;
  }
  .error {
    color: var(--danger, #dc2626);
    font-size: 13px;
    margin: 8px 0 0;
  }
  .row {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  }
  .row button {
    width: 100%;
  }
  .row.two {
    gap: 8px;
  }
  .danger {
    margin-top: 22px;
    padding: 14px;
    border: 1px solid var(--danger-soft, #fecaca);
    border-radius: var(--r-2, 8px);
  }
  .danger h3 {
    color: var(--danger, #b91c1c);
    margin-bottom: 8px;
  }
  .consequences {
    margin: 8px 0 0;
    padding-left: 18px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-3);
  }
  .consequences li {
    margin-bottom: 6px;
  }
  .danger-btn.wide {
    width: 100%;
  }
  .ghost-btn {
    padding: 10px 14px;
    min-height: 44px;
    font: inherit;
    font-size: 13px;
    font-weight: 550;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    cursor: pointer;
  }
  .ok {
    color: var(--ok, #059669);
    font-size: 13px;
    margin: 8px 0 0;
  }

  @media (max-width: 560px) {
    .modal {
      inset: 0;
      top: 0;
      left: 0;
      transform: none;
      width: 100vw;
      max-height: 100dvh;
      height: 100dvh;
      border-radius: 0;
      border: 0;
    }
    dl {
      grid-template-columns: 1fr;
      gap: 2px 0;
    }
    dt {
      margin-top: 10px;
    }
    .confirm {
      flex-direction: column;
      align-items: stretch;
    }
    .confirm button {
      width: 100%;
    }
  }
</style>

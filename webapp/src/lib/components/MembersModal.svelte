<script lang="ts">
  import Icon from '../Icon.svelte'
  import { app } from '../state.svelte'
  import { directory } from '../directory.svelte'
  import { fingerprint } from '../identity'

  let { onclose }: { onclose: () => void } = $props()

  let peerKey = $state('')
  // Off by default: pre-join opacity is the protocol's rule, and disclosing the
  // backlog must be a deliberate act rather than something you tick past.
  let shareHistory = $state(false)
  let busy = $state(false)
  let error = $state('')
  let copied = $state('')

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      copied = what
      setTimeout(() => (copied = ''), 1200)
    } catch {
      /* clipboard may be blocked; ignore */
    }
  }

  async function add() {
    error = ''
    busy = true
    try {
      await app.addMember(peerKey, shareHistory)
      peerKey = ''
    } catch (e) {
      error = e instanceof Error ? e.message : 'could not add member'
    } finally {
      busy = false
    }
  }

  async function rotate() {
    busy = true
    try {
      await app.rotateKey()
    } finally {
      busy = false
    }
  }

  // Admit a pending requester: the same add-by-key path, so it mints an epoch and
  // wraps the key to them. History is not shared on an admit-from-request —
  // sharing the backlog stays the deliberate, checkbox-gated act it is above.
  async function admit(pubHex: string) {
    error = ''
    busy = true
    try {
      await app.addMember(pubHex, false)
    } catch (e) {
      error = e instanceof Error ? e.message : 'could not admit member'
    } finally {
      busy = false
    }
  }
</script>

<div
  class="scrim"
  role="button"
  tabindex="0"
  onclick={(e) => e.target === e.currentTarget && onclose()}
  onkeydown={(e) => e.key === 'Escape' && onclose()}
>
  <div class="modal" role="dialog" aria-modal="true" tabindex="-1">
    <div class="m-head">
      <h2>Members &amp; keys</h2>
      <span class="meta">epoch {app.epoch()}</span>
      <button class="x" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
    </div>

    <div class="m-body">
      <div class="field">
        <!-- The roster this panel's title always implied but never had. -->
        <label for="roster">In this room <span class="count">{app.members.length}</span></label>
        <ul id="roster" class="roster">
          {#each app.members as m (m.pubHex)}
            <li>
              <span class="who">
                {#if m.mine}
                  <strong>You</strong>
                {:else if directory.memberName(m.pubHex)}
                  <strong>{directory.memberName(m.pubHex)}</strong>
                {:else}
                  <!-- No verified attestation from our household: show the key,
                       never an unverified self-chosen name. -->
                  <span class="unresolved">cairn:{m.pubHex.slice(0, 6)}</span>
                {/if}
                {#if m.role === 'admin'}<span class="role">admin</span>{/if}
              </span>
              <code class="fpr">{fingerprint(m.pub)}</code>
            </li>
          {:else}
            <li class="none">No members folded yet — the room's history may still be syncing.</li>
          {/each}
        </ul>
      </div>

      {#if app.joinRequests.length > 0}
        <div class="field">
          <label for="requests">
            Wants to join <span class="count">{app.joinRequests.length}</span>
          </label>
          <ul id="requests" class="roster">
            {#each app.joinRequests as r (r.pubHex)}
              <li>
                <span class="who">
                  {#if directory.memberName(r.pubHex)}
                    <strong>{directory.memberName(r.pubHex)}</strong>
                  {:else}
                    <span class="unresolved">cairn:{r.pubHex.slice(0, 6)}</span>
                  {/if}
                  {#if r.reason}<span class="reason">{r.reason}</span>{/if}
                </span>
                <button class="btn primary sm" disabled={busy} onclick={() => admit(r.pubHex)}>Admit</button>
              </li>
            {/each}
          </ul>
          <p class="hint">Admitting mints a new key epoch and wraps it to them.</p>
        </div>
      {/if}

      <div class="field">
        <label for="mykey">Your member key</label>
        <div class="keyrow">
          <code id="mykey">{app.myKey()}</code>
          <button class="btn sm" onclick={() => copy('mine', app.myKey())}>
            {copied === 'mine' ? 'copied' : 'copy'}
          </button>
        </div>
        <p class="hint">Share this with another device so it can be added to the room.</p>
      </div>

      <div class="field">
        <label for="peer">Add a member by key</label>
        <div class="keyrow">
          <input
            id="peer"
            placeholder="paste a 64-hex member key"
            bind:value={peerKey}
            spellcheck="false"
          />
          <button class="btn primary sm" disabled={busy || !peerKey.trim()} onclick={add}>Add</button>
        </div>
        {#if error}<p class="err">{error}</p>{/if}
        <label class="share">
          <input type="checkbox" bind:checked={shareHistory} />
          <span>
            Let them read past messages
            <small>
              {#if shareHistory}
                They'll get the keys to this room's existing history. <strong>This can't be
                undone</strong> — removing them later doesn't take back what they can already
                read, and everyone in the room can see history was shared.
              {:else}
                Off: they'll only see messages from now on. Past messages stay unreadable to
                them, even though they're in the room.
              {/if}
            </small>
          </span>
        </label>
        <p class="hint">Mints a new key epoch and HPKE-wraps it to every member.</p>
      </div>

      <div class="row-actions">
        <button class="btn" disabled={busy} onclick={rotate}>
          <Icon name="sync" size={14} /> Rotate key
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .roster {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .roster li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    font-size: 13px;
  }
  .roster li.none {
    justify-content: flex-start;
    border-style: dashed;
    color: var(--text-3);
    font-size: 12px;
  }
  .who { display: flex; align-items: center; gap: 7px; }
  .unresolved { font-family: var(--font-mono, monospace); color: var(--text-3); }
  .reason { font-size: 12px; color: var(--text-3); font-style: italic; }
  .role {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .fpr {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--text-3);
  }
  .count {
    font-family: var(--font-mono, monospace);
    color: var(--text-3);
  }
  .share {
    display: flex;
    gap: 9px;
    align-items: flex-start;
    margin: 10px 0 4px;
    cursor: pointer;
    font-size: 13px;
  }
  .share input {
    margin-top: 2px;
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    accent-color: var(--accent, #2563eb);
  }
  .share small {
    display: block;
    margin-top: 3px;
    font-size: 11.5px;
    line-height: 1.55;
    color: var(--text-3);
  }
  .scrim {
    position: fixed;
    inset: 0;
    background: color-mix(in oklab, oklch(0.05 0.01 260) 50%, transparent);
    backdrop-filter: blur(2px);
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .modal {
    width: min(480px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-4);
    box-shadow: var(--shadow-3);
    overflow: hidden;
    cursor: default;
  }
  .m-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 18px 12px;
  }
  .m-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .m-head .meta { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
  .m-head .x {
    margin-left: auto;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--text-3);
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .m-head .x:hover { background: var(--surface-2); color: var(--text); }
  .m-body { padding: 4px 18px 18px; display: flex; flex-direction: column; gap: 16px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 12px; font-weight: 500; color: var(--text-2); }
  .keyrow { display: flex; gap: 8px; align-items: center; }
  .keyrow code {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 8px 10px;
    overflow-x: auto;
    white-space: nowrap;
    color: var(--text-2);
  }
  .keyrow input {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 9px 11px;
    color: var(--text);
    outline: none;
  }
  .keyrow input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .hint { margin: 0; font-size: 11.5px; color: var(--text-3); line-height: 1.4; }
  .err { margin: 0; font-size: 12px; color: var(--neg); }
  .row-actions { display: flex; gap: 8px; padding-top: 4px; }
  .btn {
    height: 30px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: var(--r-2);
    font-size: 12.5px;
    font-weight: 600;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--surface-2); border-color: var(--border-2); }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.05); }
  .btn.sm { height: 28px; padding: 0 10px; font-size: 12px; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>

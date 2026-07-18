<script lang="ts">
  import Icon from '../Icon.svelte'
  import { app } from '../state.svelte'

  let { onclose }: { onclose: () => void } = $props()

  let peerKey = $state('')
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
      await app.addMember(peerKey)
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
        <p class="hint">Mints a new key epoch and HPKE-wraps it to every member. Pre-join history stays opaque.</p>
      </div>

      <div class="row-actions">
        <button class="btn" onclick={() => copy('link', app.keyLink())}>
          <Icon name="key" size={14} /> {copied === 'link' ? 'link copied' : 'Copy room-key link'}
        </button>
        <button class="btn" disabled={busy} onclick={rotate}>
          <Icon name="sync" size={14} /> Rotate key
        </button>
      </div>
    </div>
  </div>
</div>

<style>
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

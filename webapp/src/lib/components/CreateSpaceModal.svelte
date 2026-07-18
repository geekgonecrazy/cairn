<script lang="ts">
  import Icon from '../Icon.svelte'
  import { app } from '../state.svelte'
  import { ui } from '../ui.svelte'

  let name = $state('')
  let busy = $state(false)
  let error = $state('')

  // The rail glyph is derived from the name, matching how spaces render there —
  // no separate stored field to keep in sync.
  const glyph = $derived(name.trim() ? name.trim().slice(0, 2).toUpperCase() : '?')

  async function create() {
    error = ''
    const n = name.trim()
    if (n.length < 2) {
      error = 'Give the space a name (2+ characters).'
      return
    }
    busy = true
    try {
      await app.createSpace(n)
      ui.closeCreateSpace()
      name = ''
    } catch (e) {
      error = e instanceof Error ? e.message : 'could not create the space'
    } finally {
      busy = false
    }
  }
</script>

<div
  class="scrim"
  role="button"
  tabindex="0"
  onclick={(e) => e.target === e.currentTarget && ui.closeCreateSpace()}
  onkeydown={(e) => e.key === 'Escape' && ui.closeCreateSpace()}
>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Create a space" tabindex="-1">
    <div class="m-head">
      <h2>Create a space</h2>
      <button class="x" aria-label="Close" onclick={() => ui.closeCreateSpace()}><Icon name="x" /></button>
    </div>

    <div class="m-body">
      <p class="lede">
        A space is a named home for a set of channels — “Family”, “Ops”, a project. You'll be its
        first member; add channels and people once it exists.
      </p>

      <div class="preview">
        <span class="tile" data-empty={glyph === '?'}>{glyph}</span>
        <span class="pname">{name.trim() || 'Untitled space'}</span>
      </div>

      <div class="field">
        <label for="space-name">Space name</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="space-name"
          autofocus
          bind:value={name}
          placeholder="e.g. Family"
          maxlength="40"
          spellcheck="false"
          onkeydown={(e) => {
            if (e.key === 'Enter') create()
          }}
        />
      </div>

      {#if error}<p class="err" role="alert">{error}</p>{/if}

      <div class="actions">
        <button class="btn" onclick={() => ui.closeCreateSpace()}>Cancel</button>
        <button class="btn primary" disabled={busy || name.trim().length < 2} onclick={create}>
          <Icon name="plus" size={13} /> Create space
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .lede { margin: 0 0 4px; font-size: 13px; line-height: 1.55; color: var(--text-2); }
  .preview {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    background: var(--surface-2);
  }
  .tile {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: var(--r-3, 10px);
    background: var(--text);
    color: var(--bg);
    font-weight: 600;
    font-size: 14px;
  }
  .tile[data-empty='true'] { background: var(--surface-3); color: var(--text-4); }
  .pname { font-size: 14px; font-weight: 600; color: var(--text); }
  .err { margin: 0; font-size: 12px; color: var(--neg, #dc2626); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }

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
    width: min(440px, 100%);
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
  .m-body { padding: 4px 18px 18px; display: flex; flex-direction: column; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 12px; font-weight: 500; color: var(--text-2); }
  .field input {
    font: inherit;
    font-size: 15px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 9px 11px;
    color: var(--text);
    outline: none;
  }
  .field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .btn {
    height: 34px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: var(--r-2);
    font-size: 13px;
    font-weight: 600;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--surface-2); }
  .btn.primary { background: var(--accent); color: var(--accent-fg, #fff); border-color: var(--accent); }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.05); }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>

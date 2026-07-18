<script lang="ts">
  import Icon from '../Icon.svelte'
  import { app } from '../state.svelte'
  import { ui } from '../ui.svelte'
  import { roomStore } from '../rooms.svelte'
  import { identity } from '../identity.svelte'

  let query = $state('')
  let creating = $state(false)
  let newName = $state('')
  let createError = $state('')

  const space = $derived(roomStore.spaces[0])
  // Falling back to your own display name implied you were in a household of
  // your own. Until you're in a room, you legitimately know of no space.
  const spaceName = $derived(space?.name ?? 'Cairn')

  const rooms = $derived(
    roomStore.rooms.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())),
  )

  async function create() {
    createError = ''
    const name = newName.trim()
    if (!name) return
    try {
      await app.createRoom(name)
      newName = ''
      creating = false
      ui.closeNav()
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e)
    }
  }
</script>

<aside class="room-list" aria-label="Rooms">
  <div class="head">
    <h2>{spaceName}</h2>
    <div class="meta">local-first · e2ee</div>
  </div>

  <div class="search">
    <Icon name="search" size={14} />
    <input placeholder="Search rooms" bind:value={query} />
  </div>

  <div class="section-label">
    Rooms <span class="count">{rooms.length}</span>
    <button class="add" title="Create a room" aria-label="Create a room" onclick={() => (creating = !creating)}>
      <Icon name="plus" size={13} />
    </button>
  </div>

  {#if creating}
    <div class="create">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        bind:value={newName}
        placeholder="Room name"
        maxlength="40"
        onkeydown={(e) => {
          if (e.key === 'Enter') create()
          if (e.key === 'Escape') creating = false
        }}
      />
      <button class="go" onclick={create} disabled={!newName.trim()}>Create</button>
    </div>
    {#if createError}<p class="err" role="alert">{createError}</p>{/if}
  {/if}

  <div class="rooms">
    {#each rooms as r (r.id)}
      <button
        class="room-item"
        aria-current={app.currentRoomId === r.id}
        onclick={() => { app.selectRoom(r.id); ui.closeNav() }}
      >
        <span class="glyph"><Icon name="hash" size={14} /></span>
        <span class="name">{r.name}</span>
      </button>
    {/each}

    {#if roomStore.isEmpty && !query}
      <!-- An empty household is the CORRECT first state, not a loading gap:
           rooms exist only because someone created them. -->
      <p class="empty">
        {#if identity.current}
          No rooms yet. Create one to start talking — or ask someone in your household to
          add you to theirs.
        {:else}
          No rooms yet.
        {/if}
      </p>
    {:else if roomStore.error}
      <p class="empty">Can't reach the server, so this list may be out of date.</p>
    {/if}
  </div>

  <div class="footer">
    <span class="status-dot" class:on={app.connected}></span>
    <span class="mode">{app.connected ? 'connected' : 'offline'}</span>
  </div>
</aside>

<style>
  .section-label .add {
    margin-left: auto;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }
  .section-label .add:hover { background: var(--surface); color: var(--text); }
  .create {
    display: flex;
    gap: 6px;
    padding: 0 10px 8px;
  }
  .create input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 7px 9px;
    font: inherit;
    font-size: 15px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 7px;
  }
  .create .go {
    padding: 7px 10px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    border: 0;
    border-radius: 7px;
    background: var(--accent, #2563eb);
    color: #fff;
    cursor: pointer;
  }
  .create .go:disabled { opacity: 0.5; cursor: default; }
  .err { margin: 0 10px 8px; font-size: 12px; color: var(--danger, #dc2626); }
  .empty {
    margin: 10px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-3);
  }
  .room-list {
    display: flex;
    flex-direction: column;
    background: var(--surface-2);
    border-right: 1px solid var(--border);
    min-height: 0;
  }
  .head { padding: 18px 18px 12px; }
  .head h2 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
  .head .meta {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    color: var(--text-3);
    margin-top: 3px;
  }
  .search { position: relative; margin: 0 12px 8px; color: var(--text-3); }
  .search :global(svg) { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); }
  .search input {
    width: 100%;
    padding: 8px 10px 8px 30px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: var(--r-2);
    font-size: 13px;
    outline: none;
  }
  .search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .section-label {
    display: flex;
    justify-content: space-between;
    padding: 14px 18px 6px;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }
  .section-label .count { font-family: var(--font-mono); color: var(--text-4); }
  .rooms { overflow-y: auto; padding: 0 8px 16px; flex: 1; min-height: 0; }
  .room-item {
    display: grid;
    grid-template-columns: 18px 1fr auto;
    gap: 10px;
    align-items: center;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    border-radius: var(--r-2);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    margin-bottom: 1px;
  }
  .room-item:hover { background: var(--surface-3); color: var(--text); }
  .room-item[aria-current='true'] {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border);
    box-shadow: var(--shadow-1);
  }
  .room-item[aria-current='true'] .name { font-weight: 600; }
  .glyph { color: var(--text-3); display: grid; place-items: center; }
  .name {
    font-size: 13.5px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding: 10px 14px;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-4);
  }
  .status-dot.on { background: var(--pos); box-shadow: 0 0 0 3px var(--pos-soft); }
  .mode {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-3);
    margin-left: auto;
  }
</style>

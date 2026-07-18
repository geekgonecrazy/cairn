<script lang="ts">
  import Icon from '../Icon.svelte'
  import { SPACES, roomGlyph } from '../data'
  import { app } from '../state.svelte'

  const space = SPACES[0]
  let query = $state('')

  const rooms = $derived(
    space.rooms.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())),
  )
</script>

<aside class="room-list" aria-label="Rooms">
  <div class="head">
    <h2>{space.name}</h2>
    <div class="meta">local-first · e2ee</div>
  </div>

  <div class="search">
    <Icon name="search" size={14} />
    <input placeholder="Search rooms" bind:value={query} />
  </div>

  <div class="section-label">
    Rooms <span class="count">{rooms.length}</span>
  </div>

  <div class="rooms">
    {#each rooms as r (r.id)}
      {@const g = roomGlyph(r.kind)}
      <button
        class="room-item"
        aria-current={app.currentRoomId === r.id}
        onclick={() => app.selectRoom(r.id)}
      >
        <span class="glyph"><Icon name={g.icon} size={14} /></span>
        <span class="name">
          {r.name}
          {#if g.agent}<span class="agent-dot" title="agent"></span>{/if}
        </span>
      </button>
    {/each}
  </div>

  <div class="footer">
    <span class="status-dot" class:on={app.connected}></span>
    <span class="mode">{app.connected ? 'connected' : 'offline'}</span>
  </div>
</aside>

<style>
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
  .agent-dot {
    width: 6px;
    height: 6px;
    background: var(--accent);
    border-radius: 1px;
    transform: rotate(45deg);
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

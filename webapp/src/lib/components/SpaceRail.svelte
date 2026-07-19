<script lang="ts">
  import Icon from '../Icon.svelte'
  import { app } from '../state.svelte'
  import { roomStore } from '../rooms.svelte'
  import { unread } from '../unread.svelte'
  import { identity } from '../identity.svelte'
  import { ui } from '../ui.svelte'

  // Only REAL spaces. A member who has not been added to any space is in none
  // and must see none — inventing a placeholder from their own display name made
  // every newcomer look like they had founded their own household, which is the
  // same fiction the deleted data.ts fixture told.
  const spaces = $derived(roomStore.spaces)

  // Total pending join requests across a space's channels, so a space needing
  // attention is flagged even when you're viewing a different one.
  function pendingIn(spaceId: string): number {
    return roomStore.inSpace(spaceId).reduce((n, r) => n + r.pendingRequests, 0)
  }

  // Unread across a space's channels, so activity in a space you're not viewing
  // still flags itself. Join requests win the badge — they need a decision.
  function unreadIn(spaceId: string): number {
    return unread.total(roomStore.inSpace(spaceId).map((r) => r.id))
  }

  const me = $derived(identity.current)
  const initials = $derived(
    me
      ? me.displayName
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w[0]?.toUpperCase() ?? '')
          .join('') || '?'
      : '?',
  )
</script>

<nav class="space-rail" aria-label="Spaces">
  <div class="logo" title="Cairn"><Icon name="house" size={18} /></div>

  {#each spaces as s (s.id)}
    <button
      class="space"
      aria-current={app.activeSpaceId === s.id}
      title={s.name}
      onclick={() => app.selectSpace(s.id)}
    >
      {s.label}
      {#if pendingIn(s.id) > 0}
        <span class="rail-badge" aria-label="{pendingIn(s.id)} waiting to join">{pendingIn(s.id)}</span>
      {:else if unreadIn(s.id) > 0}
        <span class="rail-badge unread" aria-label="{unreadIn(s.id)} unread">{unreadIn(s.id)}</span>
      {/if}
    </button>
  {/each}

  <button class="space add" title="Create a space" aria-label="Create a space" onclick={() => ui.openCreateSpace()}>
    <Icon name="plus" size={16} />
  </button>

  <div class="grow"></div>

  <button class="icon-rail" title="Settings" aria-label="Settings"><Icon name="settings" /></button>
  <button
    class="me"
    title={me ? `${me.displayName} · ${me.deviceLabel} · Identity & devices` : 'Identity & devices'}
    aria-label="Identity and devices"
    onclick={() => ui.openIdentity()}
  >
    {initials}
  </button>
</nav>

<style>
  /* Quieter than the join-request badge: unread is information, a pending
     request is a decision waiting on you. */
  /* Same reasoning as the sidebar badge: readable, not a muted blob. Join
     requests keep the accent — they need a decision, unread just needs noticing. */
  .rail-badge.unread {
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border-2);
  }
  .space-rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 14px 0 12px;
    gap: 10px;
    background: var(--surface-2);
    border-right: 1px solid var(--border);
  }
  .logo {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    margin-bottom: 8px;
    color: var(--accent);
  }
  .space {
    position: relative;
    width: 36px;
    height: 36px;
    border-radius: var(--r-3);
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-2);
    font-weight: 600;
    font-size: 12px;
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }
  .space:hover { color: var(--text); border-color: var(--border-2); }
  .space[aria-current='true'] { background: var(--text); color: var(--bg); }
  .space[aria-current='true']::before {
    content: '';
    position: absolute;
    left: -10px;
    width: 3px;
    height: 18px;
    border-radius: 0 2px 2px 0;
    background: var(--accent);
  }
  .space.add { color: var(--text-3); border-style: dashed; }
  .rail-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--accent, #2563eb);
    color: var(--accent-fg, #fff);
    font-size: 10px;
    font-weight: 700;
    font-family: var(--font-mono);
    border: 2px solid var(--surface-2);
  }
  .grow { flex: 1; }
  .icon-rail {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--text-3);
    border-radius: var(--r-2);
    cursor: pointer;
  }
  .icon-rail:hover { color: var(--text); background: var(--surface-3); }
  /* Now a button (opens identity & devices), so reset UA button styling. */
  .me {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: #fff;
    font-weight: 600;
    font-size: 12px;
    font-family: inherit;
    border: 0;
    padding: 0;
    cursor: pointer;
    background: linear-gradient(135deg, oklch(0.62 0.1 35), oklch(0.55 0.13 25));
  }
  .me:hover {
    filter: brightness(1.12);
  }
  .me:focus-visible {
    outline: 2px solid var(--accent, #2563eb);
    outline-offset: 2px;
  }
  @media (pointer: coarse) {
    .me { width: 40px; height: 40px; }
  }
</style>

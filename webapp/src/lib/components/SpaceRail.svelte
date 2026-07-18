<script lang="ts">
  import Icon from '../Icon.svelte'
  import { roomStore } from '../rooms.svelte'
  import { identity } from '../identity.svelte'
  import { ui } from '../ui.svelte'

  // Only REAL spaces. A member who has not been added to any room is in no
  // space and must see none — inventing a placeholder from their own display
  // name made every newcomer look like they had founded their own household,
  // which is the same fiction the deleted data.ts fixture told.
  const spaces = $derived(roomStore.spaces)

  // Derived, not $state: spaces load asynchronously, so capturing spaces[0] at
  // init would pin an empty household's placeholder forever (and crash when
  // there are none).
  const activeSpace = $derived(spaces[0]?.id ?? '')

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
      aria-current={activeSpace === s.id}
      title={s.name}
    >
      {s.label}
    </button>
  {/each}

  <button class="space add" title="Add space" aria-label="Add space">
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

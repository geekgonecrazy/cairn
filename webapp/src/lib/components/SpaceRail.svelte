<script lang="ts">
  import Icon from '../Icon.svelte'
  import { SPACES } from '../data'

  let activeSpace = $state(SPACES[0].id)
</script>

<nav class="space-rail" aria-label="Spaces">
  <div class="logo" title="Cairn"><Icon name="house" size={18} /></div>

  {#each SPACES as s (s.id)}
    <button
      class="space"
      aria-current={activeSpace === s.id}
      title={s.name}
      onclick={() => (activeSpace = s.id)}
    >
      {s.label}
    </button>
  {/each}

  <button class="space add" title="Add space" aria-label="Add space">
    <Icon name="plus" size={16} />
  </button>

  <div class="grow"></div>

  <button class="icon-rail" title="Settings" aria-label="Settings"><Icon name="settings" /></button>
  <div class="me" title="You">Y</div>
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
  .me {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: #fff;
    font-weight: 600;
    font-size: 12px;
    background: linear-gradient(135deg, oklch(0.62 0.1 35), oklch(0.55 0.13 25));
  }
</style>

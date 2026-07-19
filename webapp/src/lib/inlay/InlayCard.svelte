<script lang="ts">
  // The inlay container: resolution, allowlisting, and honest degradation.
  //
  // `text` is mandatory on every inlay and is always reachable — "rendering
  // degrades; delivery does not." An unresolvable declaration is not an error
  // state, it is one calm line until a fat link returns. Never a dead spinner.
  import Icon from '../Icon.svelte'
  import InlayRenderer from './InlayRenderer.svelte'
  import { resolveDeclaration, isAllowed, allowInRoom, STD_CIDS } from './registry'
  import type { Action, InlayInstance, InlayPhase } from './types'

  let {
    instance,
    room,
    memberHexes,
    onaction,
  }: {
    instance: InlayInstance
    room: string
    /** Room roster (member-root hexes) — an agent in the room may declare UI. */
    memberHexes?: string[]
    onaction?: (a: Action) => void
  } = $props()

  let showText = $state(false)
  let justAllowed = $state(false) // admin allowed it during this session

  const decl = $derived(resolveDeclaration(instance.decl_cid))
  const allowed = $derived(justAllowed || isAllowed(instance.decl_cid, room, memberHexes))
  const isStd = $derived(STD_CIDS.has(instance.decl_cid))

  const phase = $derived<InlayPhase>(
    showText ? 'text' : !decl ? 'error' : !allowed ? 'text' : 'rendered',
  )

  function allow() {
    allowInRoom(instance.decl_cid, room)
    justAllowed = true
  }
</script>

{#if instance.widget}
  <!-- Widgets NEVER render inline: placeholder + Open, sandboxed in the shell. -->
  <div class="inlay widget-inlay" role="group" aria-label="Widget">
    <div class="wg-preview"><div class="wg-glyph"><Icon name="spark" size={18} /></div><span class="wg-chip">WIDGET</span></div>
    <div class="wg-body">
      <div class="wg-title">{decl?.name ?? 'Component'}</div>
      <div class="wg-fallback">{instance.text}</div>
      <div class="wg-foot">
        <button class="btn primary">Open</button>
        <span class="wg-sandbox"><Icon name="shield" size={12} /> sandboxed · runs only when opened</span>
      </div>
    </div>
  </div>
{:else}
  <div class="inlay" data-phase={phase} role="group" aria-label={decl?.name ?? 'inlay'}>
    {#if phase === 'rendered' && decl}
      <InlayRenderer node={decl.schema} scope={instance.bindings ?? {}} actions={decl.actions ?? []} {onaction} />
      <div class="foot">
        <span class="decl-id" title={instance.decl_cid}>
          {decl.name} · {isStd ? 'standard library' : 'declared'} · {instance.decl_cid.slice(0, 8)}
        </span>
        <button class="btn ghost sm" onclick={() => (showText = true)}>Show text</button>
      </div>
    {:else if phase === 'error'}
      <!-- Declaration not resolvable: one calm line, plus the fallback. -->
      <div class="fallback err">
        <Icon name="warning" size={15} />
        <span>{instance.text} <span class="note">— declaration unavailable ({instance.decl_cid.slice(0, 8)}…)</span></span>
      </div>
    {:else}
      <div class="fallback">
        <Icon name="leaf" size={15} />
        <span>{instance.text}</span>
        {#if decl && !allowed}
          <span class="note">— declaration not allowed in this room</span>
        {/if}
      </div>
      <div class="foot">
        {#if decl && !allowed}
          <!-- Default-deny admin surface: declarations are curated per room. -->
          <span class="decl-id" title={instance.decl_cid}>{decl.name} · {instance.decl_cid.slice(0, 8)}</span>
          <button class="btn sm" onclick={allow}>Allow in this room</button>
        {:else if decl}
          <span class="decl-id">{decl.name}</span>
          <button class="btn ghost sm" onclick={() => (showText = false)}>Show card</button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .inlay {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: var(--r-4);
    margin: 6px 24px 10px;
    overflow: hidden;
    box-shadow: var(--shadow-1);
    max-width: 560px;
  }
  .inlay[data-phase='error'] { border-color: color-mix(in oklab, var(--busy) 35%, var(--border)); }

  .fallback { display: flex; align-items: center; gap: 10px; padding: 13px 14px; font-size: 13px; color: var(--text); }
  .fallback :global(svg) { color: var(--pos); flex-shrink: 0; }
  .fallback.err :global(svg) { color: var(--busy); }
  .fallback span { flex: 1; text-wrap: pretty; }
  .fallback .note { color: var(--text-3); }

  .foot {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px 10px; border-top: 1px solid var(--border);
    background: var(--surface-2);
  }
  .decl-id {
    flex: 1; font: 500 10.5px/1 var(--font-mono); color: var(--text-3);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .btn {
    height: 30px; padding: 0 12px; border-radius: var(--r-2);
    font-size: 12.5px; font-weight: 600; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .btn:hover { background: var(--surface-2); border-color: var(--border-2); }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .btn.ghost { border-color: transparent; background: transparent; color: var(--text-2); }
  .btn.ghost:hover { background: var(--surface-3); color: var(--text); }
  .btn.sm { height: 26px; padding: 0 10px; font-size: 12px; }

  /* widget placeholder */
  .widget-inlay { display: grid; grid-template-columns: 116px 1fr; max-width: 460px; }
  .wg-preview {
    position: relative; display: grid; place-items: center; overflow: hidden;
    background: linear-gradient(140deg, var(--surface-3), var(--surface-2));
  }
  .wg-preview::after {
    content: ''; position: absolute; inset: 0;
    background-image: repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.06) 0 1px, transparent 1px 9px);
  }
  .wg-glyph {
    width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
    color: var(--text-2); border: 1.5px dashed var(--border-2); position: relative; z-index: 1;
  }
  .wg-chip {
    position: absolute; bottom: 9px; left: 50%; transform: translateX(-50%);
    font: 700 9px/1 var(--font-mono); letter-spacing: 0.12em; color: var(--text-2);
    background: var(--surface); padding: 3px 6px; border-radius: 3px; z-index: 1;
  }
  .wg-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
  .wg-title { font-size: 13.5px; font-weight: 600; color: var(--text); }
  .wg-fallback { font-size: 12.5px; color: var(--text-2); line-height: 1.45; margin: 4px 0 8px; }
  .wg-foot { display: flex; align-items: center; gap: 10px; margin-top: auto; }
  .wg-sandbox { font: 500 10.5px/1 var(--font-mono); color: var(--text-3); display: inline-flex; align-items: center; gap: 5px; }
  .wg-sandbox :global(svg) { color: var(--text-4); }

  @media (max-width: 520px) {
    .widget-inlay { grid-template-columns: 84px 1fr; }
  }
</style>

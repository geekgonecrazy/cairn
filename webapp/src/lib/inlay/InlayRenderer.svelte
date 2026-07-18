<script lang="ts">
  // THE role renderer. One audited component walks any declaration's schema and
  // maps semantic roles to themed UI. Adding a new kind of inlay means shipping
  // a new DECLARATION (data) — never a new component. Presentation lives here and
  // only here; declarations never name a colour.
  import Self from './InlayRenderer.svelte'
  import Icon from '../Icon.svelte'
  import { resolve, asString, asNumber, rowsFor } from './bindings'
  import { relTime, polarityOf, sparkPath } from './Primitives.svelte'
  import { resolveDeclaration } from './registry'
  import type { Action, Node } from './types'

  let {
    node,
    scope,
    actions = [],
    onaction,
  }: {
    node: Node
    scope: unknown
    actions?: Action[]
    onaction?: (a: Action) => void
  } = $props()

  const raw = $derived('bind' in node ? resolve(scope, node.bind) : undefined)

  // A `number` may bind a plain scalar or a {value, delta, trend} record.
  const numRec = $derived(
    raw && typeof raw === 'object' && 'value' in (raw as object) ? (raw as Record<string, unknown>) : null,
  )
</script>

{#if node.role === 'text'}
  <div class="p-text" data-emph={node.emphasis ?? 'body'}>
    {asString(raw ?? node.value)}
  </div>

{:else if node.role === 'number'}
  {@const n = numRec ? asNumber(numRec.value) : (asNumber(raw) ?? node.value)}
  {@const delta = numRec ? asNumber(numRec.delta) : undefined}
  {@const trend = numRec ? String(numRec.trend ?? '') : ''}
  <div class="prim-num">
    <span class="pn-v">{n ?? '—'}</span>
    {#if node.unit}<span class="pn-u">{node.unit}</span>{/if}
    {#if node.showTrend && delta !== undefined && trend}
      <span class="pn-d {trend}">{trend === 'up' ? '▲' : trend === 'down' ? '▼' : '■'} {delta}</span>
    {/if}
  </div>

{:else if node.role === 'progress_fraction'}
  {@const v = Math.max(0, Math.min(1, asNumber(raw) ?? node.value ?? 0))}
  <div
    class="prim-prog"
    data-polarity={node.polarity ?? 'neutral'}
    role="progressbar"
    aria-valuenow={Math.round(v * 100)}
    aria-valuemin="0"
    aria-valuemax="100"
  >
    {#if node.label}<span class="pp-l">{node.label}</span>{/if}
    <span class="pp-track"><span class="pp-fill" style="width:{v * 100}%"></span></span>
    <span class="pp-pct">{Math.round(v * 100)}%</span>
  </div>

{:else if node.role === 'status_enum'}
  {@const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null}
  {@const label = rec ? asString(rec.label) : asString(raw ?? node.label)}
  {@const pol = polarityOf(rec ? rec.polarity : (node.polarity ?? raw))}
  <span class="status-chip" data-polarity={pol}>
    <span class="swatch"></span>{label || '—'}
  </span>

{:else if node.role === 'timestamp'}
  {@const t = asNumber(raw) ?? node.value}
  <span class="prim-ts">
    {t ? relTime(t) : '—'}
    {#if node.showAbsolute && t}
      <span class="pt-abs">· {new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    {/if}
  </span>

{:else if node.role === 'image_cid'}
  {@const cid = asString(raw)}
  <!-- Files land with the data plane; until a fat link resolves it, say so
       honestly rather than spin forever. -->
  <div
    class="prim-thumb {cid ? 'state-loading' : 'state-broken'}"
    style="width:{node.size ?? 46}px;height:{node.size ?? 46}px"
    aria-label={node.alt ?? 'image'}
    title={cid ? `pending — no fat link (${cid.slice(0, 10)}…)` : 'no image'}
  >
    <Icon name="image" size={16} />
  </div>

{:else if node.role === 'series'}
  {@const data = (Array.isArray(raw) ? raw : (node.values ?? [])).map((x) => Number(x)).filter((x) => !Number.isNaN(x))}
  {@const geo = sparkPath(data, 240, 40)}
  <div class="p-series">
    {#if node.label}
      <div class="gh-series-head"><span class="gh-series-k">{node.label}</span></div>
    {/if}
    {#if geo}
      {@const pol = node.polarity ?? 'neutral'}
      <svg class="spark" width="240" height="40" viewBox="0 0 240 40" preserveAspectRatio="none" aria-hidden="true">
        {#if node.band}
          {@const b = geo.bandRect(node.band[0], node.band[1])}
          <rect x="0" y={b.y} width="240" height={b.h} class="band" data-polarity={pol} />
        {/if}
        <path d={geo.area} class="area" data-polarity={pol} />
        <path d={geo.line} class="line" data-polarity={pol} fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx={geo.lastX} cy={geo.lastY} r="2.2" class="dot" data-polarity={pol} />
      </svg>
    {:else}
      <div class="spark spark-empty" style="width:240px;height:40px"></div>
    {/if}
  </div>

{:else if node.role === 'action_ref'}
  {@const a = actions.find((x) => x.id === node.action_id)}
  {#if a}
    <div class="p-action">
      <!-- No invisible interactions: a capability-bound action always shows its
           capability, and carries an accent ring. -->
      {#if a.capability_request}
        <div class="cap-disclose">
          <Icon name="key" size={12} />
          authorizes <code>{a.capability_request}</code>{a.scope ? ` · ${a.scope}` : ''}
        </div>
      {/if}
      <button
        class="btn {a.variant ?? 'default'}"
        data-cap={a.capability_request ? 'true' : 'false'}
        title={a.capability_request ? `Authorizes ${a.capability_request}${a.scope ? ` — ${a.scope}` : ''}` : a.label}
        onclick={() => onaction?.(a)}
      >
        {#if a.capability_request}<Icon name="key" size={13} />{/if}
        {a.label}{a.kind === 'modal' ? '…' : ''}
      </button>
    </div>
  {/if}

{:else if node.role === 'input'}
  <label class="p-field">
    {#if node.label}<span class="pf-k">{node.label}</span>{/if}
    <input
      class="pf-input"
      type={node.inputType ?? 'text'}
      name={node.name}
      placeholder={node.placeholder ?? ''}
      value={asString(raw)}
    />
  </label>

{:else if node.role === 'select'}
  <label class="p-field">
    {#if node.label}<span class="pf-k">{node.label}</span>{/if}
    <select class="pf-input" name={node.name} value={asString(raw)}>
      {#each node.options as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
  </label>

{:else if node.role === 'record'}
  <div class="prim-record" style="grid-template-columns: repeat({node.cols ?? 1}, minmax(0,1fr))">
    {#each node.fields as f (f.key)}
      <div class="pr-field" data-flag={f.flag ?? ''}>
        <div class="pr-k">{f.key}</div>
        <div class="pr-v"><Self node={f.node} {scope} {actions} {onaction} /></div>
        {#if f.note}<div class="pr-note">{f.note}</div>{/if}
      </div>
    {/each}
  </div>

{:else if node.role === 'list'}
  {@const rows = rowsFor(scope, node)}
  {#if rows.length === 0}
    <div class="p-empty">{node.empty ?? 'Nothing here.'}</div>
  {:else}
    <div class="p-list">
      {#each rows as row, i (i)}
        <!-- list rows scope their item's binds to the row itself -->
        <div class="p-row"><Self node={node.item} scope={row} {actions} {onaction} /></div>
      {/each}
    </div>
  {/if}

{:else if node.role === 'group'}
  <div class="p-group">
    {#if node.header}
      <div class="p-group-head"><Self node={node.header} {scope} {actions} {onaction} /></div>
    {/if}
    <div class="p-group-body">
      {#each node.children as c, i (i)}
        <Self node={c} {scope} {actions} {onaction} />
      {/each}
    </div>
  </div>

{:else if node.role === 'inlay_ref'}
  <!-- Composition by hash: a panel is not one fact, it's a whole assembly. -->
  {@const sub = resolveDeclaration(node.decl_cid)}
  {#if sub}
    <div class="p-ref">
      <Self node={sub.schema} scope={node.bindings ?? scope} actions={sub.actions ?? []} {onaction} />
    </div>
  {:else}
    <div class="p-empty">referenced inlay unavailable</div>
  {/if}
{/if}

<style>
  .p-text { font-size: 13.5px; color: var(--text); line-height: 1.45; text-wrap: pretty; }
  .p-text[data-emph='title'] { font-weight: 600; letter-spacing: -0.005em; }
  .p-text[data-emph='note'] {
    font: 500 10px/1 var(--font-mono); color: var(--text-3);
    text-transform: uppercase; letter-spacing: 0.06em;
  }

  .prim-num { display: inline-flex; align-items: baseline; gap: 4px; font-variant-numeric: tabular-nums; }
  .prim-num .pn-v { font-size: 19px; font-weight: 600; letter-spacing: -0.02em; color: var(--text); }
  .prim-num .pn-u { font: 500 11px/1 var(--font-mono); color: var(--text-3); }
  .prim-num .pn-d { font: 500 10.5px/1 var(--font-mono); letter-spacing: 0.02em; margin-left: 2px; }
  .prim-num .pn-d.up { color: var(--pos); }
  .prim-num .pn-d.down { color: var(--busy); }
  .prim-num .pn-d.flat { color: var(--text-4); }

  .prim-prog { display: flex; align-items: center; gap: 8px; }
  .prim-prog .pp-l { font-size: 12px; color: var(--text-3); }
  .prim-prog .pp-track { flex: 1; height: 5px; background: var(--surface-3); border-radius: 999px; overflow: hidden; }
  .prim-prog .pp-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 500ms cubic-bezier(0.2, 0.7, 0.2, 1); }
  .prim-prog[data-polarity='positive'] .pp-fill { background: var(--pos); }
  .prim-prog[data-polarity='negative'] .pp-fill { background: var(--neg); }
  .prim-prog[data-polarity='busy'] .pp-fill { background: var(--busy); }
  .prim-prog .pp-pct { font: 600 11px/1 var(--font-mono); color: var(--text-2); min-width: 34px; text-align: right; }

  .status-chip {
    display: inline-flex; align-items: center; gap: 6px;
    font: 500 11px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em;
    padding: 3px 7px 3px 6px; border-radius: var(--r-1);
    border: 1px solid var(--border-2); background: var(--surface-2); color: var(--text-2);
  }
  .status-chip .swatch { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); }
  .status-chip[data-polarity='positive'] { color: var(--pos); background: var(--pos-soft); border-color: color-mix(in oklab, var(--pos) 35%, var(--border)); }
  .status-chip[data-polarity='positive'] .swatch { background: var(--pos); }
  .status-chip[data-polarity='negative'] { color: var(--neg); background: var(--neg-soft); border-color: color-mix(in oklab, var(--neg) 40%, var(--border)); }
  .status-chip[data-polarity='negative'] .swatch { background: var(--neg); }
  .status-chip[data-polarity='busy'] { color: var(--busy); background: var(--busy-soft); border-color: color-mix(in oklab, var(--busy) 40%, var(--border)); }
  .status-chip[data-polarity='busy'] .swatch { background: var(--busy); animation: pulseDot 1.6s ease-in-out infinite; }
  @keyframes pulseDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .prim-ts { font: 500 11.5px/1 var(--font-mono); color: var(--text-3); letter-spacing: 0.01em; }
  .prim-ts .pt-abs { color: var(--text-4); }

  .prim-thumb {
    border-radius: var(--r-2); display: grid; place-items: center;
    background: var(--surface-2); color: var(--text-4); flex-shrink: 0;
  }
  .prim-thumb.state-broken { border: 1px dashed var(--border-2); }

  .p-series { padding: 4px 0; }
  .gh-series-head { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .gh-series-k { font: 500 10px/1 var(--font-mono); color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; }
  .spark { display: block; overflow: visible; max-width: 100%; }
  .spark-empty { background: var(--surface-2); border-radius: var(--r-1); }
  .band { fill: var(--pos); opacity: 0.08; }
  .band[data-polarity='neutral'] { fill: var(--accent); }
  .line { stroke: var(--accent); }
  .line[data-polarity='positive'] { stroke: var(--pos); }
  .line[data-polarity='negative'] { stroke: var(--neg); }
  .line[data-polarity='busy'] { stroke: var(--busy); }
  .area { fill: var(--accent); opacity: 0.12; }
  .area[data-polarity='positive'] { fill: var(--pos); }
  .area[data-polarity='negative'] { fill: var(--neg); }
  .area[data-polarity='busy'] { fill: var(--busy); }
  .dot { fill: var(--accent); }
  .dot[data-polarity='positive'] { fill: var(--pos); }
  .dot[data-polarity='negative'] { fill: var(--neg); }
  .dot[data-polarity='busy'] { fill: var(--busy); }

  .p-action { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .cap-disclose {
    font: 500 10.5px/1.3 var(--font-mono); color: var(--text-3);
    display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;
  }
  .cap-disclose :global(svg) { color: var(--accent); flex-shrink: 0; }
  .cap-disclose code {
    color: var(--text); background: var(--surface-2); border: 1px solid var(--border);
    padding: 1px 5px; border-radius: 4px;
  }
  .btn {
    height: 30px; padding: 0 12px; border-radius: var(--r-2);
    font-size: 12.5px; font-weight: 600; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .btn:hover { background: var(--surface-2); border-color: var(--border-2); }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .btn.primary:hover { filter: brightness(1.05); }
  .btn.danger { color: var(--neg); border-color: color-mix(in oklab, var(--neg) 40%, var(--border)); }
  .btn.danger:hover { background: var(--neg-soft); border-color: var(--neg); }
  .btn.ghost { border-color: transparent; background: transparent; color: var(--text-2); }
  .btn.ghost:hover { background: var(--surface-2); color: var(--text); }
  .btn[data-cap='true'] { box-shadow: 0 0 0 1px color-mix(in oklab, var(--accent) 30%, transparent); }

  .p-field { display: flex; flex-direction: column; gap: 5px; }
  .pf-k { font-size: 12px; font-weight: 500; color: var(--text-2); }
  .pf-input {
    border: 1px solid var(--border); background: var(--surface); color: var(--text);
    border-radius: var(--r-2); padding: 8px 10px; font: inherit; font-size: 13px; outline: none;
  }
  .pf-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

  .prim-record {
    display: grid; gap: 1px; background: var(--border);
    border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  }
  .pr-field { background: var(--surface); padding: 11px 14px 10px; min-width: 0; }
  .pr-field[data-flag='warn'] { background: color-mix(in oklab, var(--busy) 5%, var(--surface)); }
  .pr-k {
    font: 500 10px/1 var(--font-mono); color: var(--text-3);
    text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px;
  }
  .pr-v { min-width: 0; }
  .pr-note { margin-top: 4px; font-size: 11px; color: var(--text-3); }

  .p-list { display: flex; flex-direction: column; }
  .p-row { padding: 9px 14px; border-top: 1px solid var(--border); }
  .p-empty { padding: 10px 14px; font-size: 12.5px; color: var(--text-3); }

  .p-group { display: flex; flex-direction: column; }
  .p-group-head { padding: 10px 14px 2px; }
  .p-group-body { display: flex; flex-direction: column; gap: 8px; padding: 6px 0; }
  .p-group-body > :global(.p-text),
  .p-group-body > :global(.prim-num),
  .p-group-body > :global(.prim-prog),
  .p-group-body > :global(.p-series),
  .p-group-body > :global(.p-action),
  .p-group-body > :global(.status-chip),
  .p-group-body > :global(.prim-ts) { margin: 0 14px; }
  .p-ref { border-top: 1px solid var(--border); }

  @media (max-width: 520px) {
    .prim-record { grid-template-columns: 1fr !important; }
  }
</style>

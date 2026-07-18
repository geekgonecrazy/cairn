<script lang="ts">
  import Icon from '../Icon.svelte'
  import { app, type Msg } from '../state.svelte'

  let { msg }: { msg: Msg } = $props()
  const a = $derived(msg.approval!)

  let busy = $state(false)

  // Polarity mapping per the design system: pending is busy/amber, approved
  // positive, denied negative, expired neutral.
  const polarity = $derived(
    a.state === 'approved' || a.state === 'minted'
      ? 'positive'
      : a.state === 'denied'
        ? 'negative'
        : a.state === 'pending'
          ? 'busy'
          : 'neutral',
  )

  const subLine = $derived(
    a.state === 'pending'
      ? `expires ${new Date(a.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : a.state === 'approved'
        ? `you signed this grant — the agent can now present it to the broker`
        : a.state === 'minted'
          ? `credential minted by the broker`
          : a.state === 'denied'
            ? `denied${a.reason ? ` — ${a.reason}` : ''}`
            : `expired without a decision`,
  )

  async function approve() {
    busy = true
    try {
      await app.approveRequest(a.request)
    } finally {
      busy = false
    }
  }
  async function deny() {
    busy = true
    try {
      await app.denyRequest(a.request)
    } finally {
      busy = false
    }
  }
</script>

<div class="inlay approval" data-state={a.state} role="group" aria-label="Capability approval request">
  <div class="head">
    <div class="icon"><Icon name="shield" size={14} /></div>
    <div class="title-block">
      <div class="title">{msg.author} requests approval</div>
      <div class="sub">{subLine}</div>
    </div>
    <span class="status-chip" data-polarity={polarity}>
      <span class="swatch"></span>{a.state}
    </span>
  </div>

  <!-- The capability is ALWAYS visible: no silent authorisation. -->
  <div class="capability-row">
    <div class="cap-cell">
      <div class="cap-k">Capability</div>
      <div class="cap-v"><code>{a.capability}</code></div>
      {#if a.params}<div class="cap-note">{a.params}</div>{/if}
    </div>
    <div class="cap-cell">
      <div class="cap-k">Scope</div>
      <div class="cap-v">{a.scope || '—'}</div>
    </div>
  </div>

  {#if a.state === 'pending'}
    <div class="disclosure">
      <Icon name="key" size={13} />
      <span>Approving signs a grant with <strong>your key</strong>, here — it authorizes a
        real-world action on your behalf.</span>
    </div>
    <div class="actions">
      <button class="btn primary" disabled={busy} onclick={approve}>
        <Icon name="check" size={14} /> Approve &amp; sign
      </button>
      <button class="btn danger" disabled={busy} onclick={deny}>
        <Icon name="x" size={14} /> Deny
      </button>
    </div>
  {:else if a.state === 'approved' || a.state === 'minted'}
    <div class="signed-note">
      <Icon name="check2" size={13} />
      <span>Signed grant emitted — portable, verifiable outside Cairn.</span>
    </div>
  {/if}
</div>

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
  .approval { border-color: color-mix(in oklab, var(--warn) 45%, var(--border)); }
  .approval[data-state='approved'],
  .approval[data-state='minted'] {
    border-color: color-mix(in oklab, var(--pos) 45%, var(--border));
    background: color-mix(in oklab, var(--pos) 6%, var(--surface));
  }
  .approval[data-state='denied'] { border-color: color-mix(in oklab, var(--neg) 40%, var(--border)); }

  .head { padding: 12px 14px 8px; display: flex; align-items: flex-start; gap: 10px; }
  .head .icon {
    width: 24px; height: 24px; border-radius: var(--r-2);
    background: var(--surface-2); display: grid; place-items: center;
    color: var(--text-2); flex-shrink: 0; margin-top: 1px;
  }
  .title-block { flex: 1; min-width: 0; }
  .title { font-weight: 600; font-size: 13.5px; color: var(--text); letter-spacing: -0.005em; }
  .sub { font-size: 12px; color: var(--text-3); margin-top: 1px; }

  .status-chip {
    display: inline-flex; align-items: center; gap: 6px;
    font: 500 11px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em;
    padding: 3px 7px 3px 6px; border-radius: var(--r-1);
    border: 1px solid var(--border-2); background: var(--surface-2); color: var(--text-2);
    flex-shrink: 0;
  }
  .status-chip .swatch { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); }
  .status-chip[data-polarity='positive'] {
    color: var(--pos); background: var(--pos-soft);
    border-color: color-mix(in oklab, var(--pos) 35%, var(--border));
  }
  .status-chip[data-polarity='positive'] .swatch { background: var(--pos); }
  .status-chip[data-polarity='negative'] {
    color: var(--neg); background: var(--neg-soft);
    border-color: color-mix(in oklab, var(--neg) 40%, var(--border));
  }
  .status-chip[data-polarity='negative'] .swatch { background: var(--neg); }
  .status-chip[data-polarity='busy'] {
    color: var(--busy); background: var(--busy-soft);
    border-color: color-mix(in oklab, var(--busy) 40%, var(--border));
  }
  .status-chip[data-polarity='busy'] .swatch { background: var(--busy); animation: pulseDot 1.6s ease-in-out infinite; }
  @keyframes pulseDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .capability-row {
    display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
    background: var(--border);
    border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  }
  .cap-cell { background: var(--surface); padding: 11px 14px 10px; min-width: 0; }
  .cap-k {
    font: 500 10px/1 var(--font-mono); color: var(--text-3);
    text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px;
  }
  .cap-v { font-size: 13px; color: var(--text); }
  .cap-v code {
    font-family: var(--font-mono); font-size: 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    padding: 1px 5px; border-radius: 4px;
  }
  .cap-note { margin-top: 4px; font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }

  .disclosure {
    display: flex; align-items: flex-start; gap: 8px;
    margin: 10px 14px 0; padding: 8px 10px;
    font-size: 11.5px; line-height: 1.4; color: var(--text-2);
    background: color-mix(in oklab, var(--warn) 8%, transparent);
    border: 1px dashed color-mix(in oklab, var(--warn) 40%, var(--border));
    border-radius: var(--r-2);
  }
  .disclosure :global(svg) { color: var(--warn); flex-shrink: 0; margin-top: 1px; }

  .signed-note {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; font-size: 12px; color: var(--text-2);
  }
  .signed-note :global(svg) { color: var(--pos); flex-shrink: 0; }

  .actions { padding: 10px 12px 12px; display: flex; gap: 8px; align-items: center; }
  .btn {
    height: 30px; padding: 0 12px; border-radius: var(--r-2);
    font-size: 12.5px; font-weight: 600;
    border: 1px solid var(--border); background: var(--surface); color: var(--text);
    cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  }
  .btn:hover:not(:disabled) { background: var(--surface-2); border-color: var(--border-2); }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.05); }
  .btn.danger { color: var(--neg); border-color: color-mix(in oklab, var(--neg) 40%, var(--border)); }
  .btn.danger:hover:not(:disabled) { background: var(--neg-soft); border-color: var(--neg); }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>

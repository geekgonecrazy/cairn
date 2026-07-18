<script lang="ts">
  import { hex } from '../api'
  import type { Msg } from '../state.svelte'

  let { msg }: { msg: Msg } = $props()

  const ev = $derived(msg.ev)
  // Short, stable author label from the sender pubkey (no identity resolution in
  // Phase 0/1). Real display names come from the household attestation later.
  const author = $derived('cairn:' + hex(ev.senderPub).slice(0, 6))
  const initial = $derived(hex(ev.senderPub).slice(0, 1).toUpperCase())
  const time = $derived(
    new Date(Number(ev.ts)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  )
</script>

<div class="msg" class:mine={msg.mine}>
  <div class="avatar" class:agent={false}>{initial}</div>
  <div class="body">
    <div class="head">
      <span class="author">{author}</span>
      <span class="time">{time}</span>
      {#if msg.mine}<span class="state">{msg.state}</span>{/if}
    </div>
    {#if msg.body !== null}
      <div class="text">{msg.body}</div>
    {:else}
      <div class="text opaque">🔒 encrypted · type {ev.type} · {hex(ev.eventId).slice(0, 10)}</div>
    {/if}
  </div>
</div>

<style>
  .msg {
    display: grid;
    grid-template-columns: 36px 1fr;
    gap: 10px;
    padding: 6px 24px;
  }
  .msg:hover { background: color-mix(in oklab, var(--surface-2) 60%, transparent); }
  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-weight: 600;
    font-size: 12px;
    color: var(--surface);
    background: linear-gradient(135deg, var(--accent), oklch(0.5 0.14 280));
    align-self: start;
    margin-top: 2px;
  }
  .head { display: flex; align-items: baseline; gap: 8px; }
  .author { font-weight: 600; font-size: 13.5px; color: var(--text); }
  .msg.mine .author { color: var(--accent); }
  .time { font-family: var(--font-mono); font-size: 11px; font-weight: 500; color: var(--text-3); }
  .state {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-3);
    text-transform: lowercase;
  }
  .text { font-size: 14px; line-height: 1.5; color: var(--text); text-wrap: pretty; }
  .text.opaque { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
</style>

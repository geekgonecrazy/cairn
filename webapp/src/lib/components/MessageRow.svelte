<script lang="ts">
  import type { Event } from '../../gen/cairn_pb'
  import { EventType } from '../../gen/cairn_pb'
  import { hex } from '../api'

  let { ev }: { ev: Event } = $props()

  // Short, stable author label from the sender pubkey (no identity resolution
  // in Phase 0). Real display names come from the household attestation later.
  const author = $derived('cairn:' + hex(ev.senderPub).slice(0, 6))
  const initial = $derived(hex(ev.senderPub).slice(0, 1).toUpperCase())
  const time = $derived(
    new Date(Number(ev.ts)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  )

  // Phase 0 payloads may be plaintext (room-key encryption lands in Phase 1). Try
  // UTF-8; if it isn't clean text, be honest that the body is opaque.
  const body = $derived(decodeBody(ev))
  const opaque = $derived(body === null)

  function decodeBody(e: Event): string | null {
    if (e.type !== EventType.CHAT) return null
    try {
      const s = new TextDecoder('utf-8', { fatal: true }).decode(e.payload)
      // Reject control-char soup — encrypted bytes decode to it.
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return null
      }
      return s
    } catch {
      return null
    }
  }
</script>

<div class="msg">
  <div class="avatar">{initial}</div>
  <div class="body">
    <div class="head">
      <span class="author">{author}</span>
      <span class="time">{time}</span>
    </div>
    {#if opaque}
      <div class="text opaque">🔒 encrypted payload · type {ev.type} · {hex(ev.eventId).slice(0, 10)}</div>
    {:else}
      <div class="text">{body}</div>
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
  .time { font-family: var(--font-mono); font-size: 11px; font-weight: 500; color: var(--text-3); }
  .text { font-size: 14px; line-height: 1.5; color: var(--text); text-wrap: pretty; }
  .text.opaque { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
</style>

<script lang="ts">
  import { hex } from '../api'
  import { app, type Msg } from '../state.svelte'
  import Icon from '../Icon.svelte'

  let { msg }: { msg: Msg } = $props()

  const QUICK = ['👍', '❤️', '😂', '🎉', '✅']

  let picking = $state(false)
  let editing = $state(false)
  let editText = $state('')

  const ev = $derived(msg.ev)
  const initial = $derived(hex(ev.senderPub).slice(0, 1).toUpperCase())
  const time = $derived(
    new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  )

  function react(emoji: string) {
    picking = false
    void app.toggleReaction(msg.idHex, emoji)
  }
  function startEdit() {
    editText = msg.body
    editing = true
  }
  function commitEdit() {
    editing = false
    if (editText.trim() && editText !== msg.body) void app.editMessage(msg.idHex, editText)
  }
  function onEditKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      editing = false
    }
  }
</script>

<div class="msg" class:mine={msg.mine}>
  <div class="avatar">{initial}</div>
  <div class="body">
    {#if msg.replyTo}
      <div class="reply-ctx">
        <Icon name="reply" size={12} />
        <span>{msg.replyPreview}</span>
      </div>
    {/if}

    <div class="head">
      <span class="author">{msg.author}</span>
      <span class="time">{time}</span>
      {#if msg.edited}<span class="edited">edited</span>{/if}
      {#if msg.mine && !msg.deleted}<span class="state">{msg.state}</span>{/if}
    </div>

    {#if msg.deleted}
      <div class="text tombstone">🚫 message withdrawn (not erased)</div>
    {:else if editing}
      <textarea
        class="edit"
        bind:value={editText}
        onkeydown={onEditKey}
        onblur={commitEdit}
        rows="1"
      ></textarea>
    {:else if msg.opaque}
      <div class="text opaque">🔒 encrypted · {hex(ev.eventId).slice(0, 10)}</div>
    {:else}
      <div class="text">{msg.body}</div>
    {/if}

    {#if msg.reactions.length > 0 && !msg.deleted}
      <div class="reactions">
        {#each msg.reactions as r (r.emoji)}
          <button class="reaction" class:mine={r.mine} onclick={() => react(r.emoji)}>
            <span class="rx-e">{r.emoji}</span><span class="rx-c">{r.count}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if !msg.deleted && !editing}
    <div class="actions">
      <div class="picker-wrap">
        <button class="act" title="React" aria-label="React" onclick={() => (picking = !picking)}>
          <Icon name="smileplus" size={15} />
        </button>
        {#if picking}
          <div class="picker">
            {#each QUICK as e (e)}
              <button onclick={() => react(e)}>{e}</button>
            {/each}
          </div>
        {/if}
      </div>
      <button class="act" title="Reply" aria-label="Reply" onclick={() => app.setReplyTo(msg)}>
        <Icon name="reply" size={15} />
      </button>
      {#if msg.mine}
        <button class="act" title="Edit" aria-label="Edit" onclick={startEdit}>
          <Icon name="settings" size={15} />
        </button>
        <button class="act danger" title="Delete" aria-label="Delete" onclick={() => app.deleteMessage(msg.idHex)}>
          <Icon name="x" size={15} />
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .msg {
    position: relative;
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
  .reply-ctx {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-3);
    font-size: 12.5px;
    margin-bottom: 2px;
    opacity: 0.9;
  }
  .reply-ctx span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60ch;
  }
  .head { display: flex; align-items: baseline; gap: 8px; }
  .author { font-weight: 600; font-size: 13.5px; color: var(--text); }
  .msg.mine .author { color: var(--accent); }
  .time { font-family: var(--font-mono); font-size: 11px; font-weight: 500; color: var(--text-3); }
  .edited { font-size: 11px; font-style: italic; color: var(--text-3); }
  .state {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-3);
    text-transform: lowercase;
  }
  .text { font-size: 14px; line-height: 1.5; color: var(--text); text-wrap: pretty; }
  .text.opaque { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
  .text.tombstone { font-size: 13px; color: var(--text-3); font-style: italic; }
  .edit {
    width: 100%;
    font: inherit;
    font-size: 14px;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--accent);
    border-radius: var(--r-2);
    padding: 6px 8px;
    resize: none;
    outline: none;
  }
  .reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .reaction {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-2);
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .reaction:hover { border-color: var(--border-2); background: var(--surface-3); }
  .reaction:active { transform: scale(0.94); }
  .reaction.mine {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: color-mix(in oklab, var(--accent) 35%, var(--border));
  }
  .rx-e { font-size: 14px; }
  .rx-c { font-family: var(--font-mono); font-weight: 600; font-size: 11px; }

  .actions {
    position: absolute;
    top: -10px;
    right: 18px;
    display: none;
    gap: 2px;
    padding: 2px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    box-shadow: var(--shadow-2);
  }
  .msg:hover .actions { display: flex; }
  .act {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--text-3);
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .act:hover { background: var(--surface-2); color: var(--text); }
  .act.danger:hover { color: var(--neg); background: var(--neg-soft); }
  .picker-wrap { position: relative; }
  .picker {
    position: absolute;
    bottom: 32px;
    right: 0;
    display: flex;
    gap: 2px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    box-shadow: var(--shadow-2);
  }
  .picker button {
    width: 30px;
    height: 30px;
    border: none;
    background: transparent;
    border-radius: var(--r-1);
    cursor: pointer;
    font-size: 17px;
  }
  .picker button:hover { background: var(--surface-2); }
</style>

<script lang="ts">
  import Icon from '../Icon.svelte'
  import { app } from '../state.svelte'

  let { roomName }: { roomName: string } = $props()
  let text = $state('')

  const canSend = $derived(text.trim().length > 0)

  async function send() {
    if (!canSend) return
    const t = text
    text = ''
    await app.sendChat(t)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }
</script>

<div class="composer-wrap">
  <div class="composer">
    <textarea
      placeholder={`Message #${roomName}`}
      bind:value={text}
      onkeydown={onKeydown}
      rows="1"
    ></textarea>
    <div class="row">
      <button class="icon-btn" title="Attach" aria-label="Attach"><Icon name="attach" /></button>
      <button class="icon-btn" title="Emoji" aria-label="Emoji"><Icon name="smileplus" /></button>
      <span class="spacer"></span>
      <span class="hint"><span class="hint-dot" class:on={app.connected}></span>e2ee</span>
      <button class="send" disabled={!canSend} onclick={send}>
        <Icon name="send" size={14} /> Send
      </button>
    </div>
  </div>
</div>

<style>
  .composer-wrap {
    flex: 0 0 auto;
    padding: 10px 18px 16px;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .composer {
    border: 1px solid var(--border);
    border-radius: var(--r-3);
    background: var(--surface);
    padding: 8px 8px 6px;
    box-shadow: var(--shadow-1);
  }
  .composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  textarea {
    width: 100%;
    border: none;
    background: transparent;
    color: var(--text);
    resize: none;
    outline: none;
    font: inherit;
    font-size: 14px;
    line-height: 1.5;
    padding: 6px 8px;
    min-height: 22px;
    max-height: 160px;
  }
  textarea::placeholder { color: var(--text-3); }
  .row { display: flex; align-items: center; gap: 4px; padding-top: 2px; }
  .icon-btn {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--text-3);
    border-radius: var(--r-2);
    cursor: pointer;
  }
  .icon-btn:hover { background: var(--surface-2); color: var(--text); }
  .spacer { flex: 1; }
  .hint {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-3);
    padding: 0 6px;
  }
  .hint-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-4); }
  .hint-dot.on { background: var(--pos); }
  .send {
    height: 28px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--accent);
    color: var(--accent-fg);
    border: 1px solid var(--accent);
    border-radius: var(--r-2);
    font-weight: 600;
    font-size: 12.5px;
    cursor: pointer;
  }
  .send:hover:not(:disabled) { filter: brightness(1.05); }
  .send:disabled {
    background: var(--surface-3);
    color: var(--text-3);
    border-color: var(--border);
    cursor: not-allowed;
  }
</style>

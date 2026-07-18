<script lang="ts">
  import Icon from '../Icon.svelte'
  import MessageRow from './MessageRow.svelte'
  import ApprovalInlay from './ApprovalInlay.svelte'
  import InlayCard from '../inlay/InlayCard.svelte'
  import Composer from './Composer.svelte'
  import MembersModal from './MembersModal.svelte'
  import { app } from '../state.svelte'
  import { findRoom, roomGlyph } from '../data'

  const room = $derived(findRoom(app.currentRoomId))
  const glyph = $derived(room ? roomGlyph(room.kind) : { icon: 'hash' })
  let showMembers = $state(false)
</script>

<section class="room">
  <header class="room-header">
    <div class="title">
      <span class="rg"><Icon name={glyph.icon} size={16} /></span>
      <div>
        <h1>{room?.name ?? app.currentRoomId}</h1>
        <div class="sub">
          {room?.sub ?? 'room'}
          {#if app.online.length > 0}
            · <span class="online"><span class="odot"></span>{app.online.length} online</span>
          {/if}
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="icon-btn" title="Members & keys" aria-label="Members and keys" onclick={() => (showMembers = true)}>
        <Icon name="users" />
      </button>
      <button class="icon-btn" title="Info" aria-label="Info"><Icon name="info" /></button>
      <button class="icon-btn" title="More" aria-label="More"><Icon name="kebab" /></button>
    </div>
  </header>

  {#if showMembers}
    <MembersModal onclose={() => (showMembers = false)} />
  {/if}

  <div class="room-body">
    {#if app.messages.length === 0}
      <div class="empty">
        <div class="empty-mark"><Icon name={glyph.icon} size={22} /></div>
        <h2>#{room?.name ?? app.currentRoomId}</h2>
        <p>
          This is the start of a verified, end-to-end-encrypted room. Messages are signed
          events in a per-room DAG — they converge across devices with no central authority.
        </p>
        <p class="muted">Say something — it's signed and sealed before it leaves this tab.</p>
      </div>
    {:else}
      {#each app.messages as msg (msg.idHex)}
        {#if msg.approval}
          <ApprovalInlay {msg} />
        {:else if msg.inlay}
          <InlayCard instance={msg.inlay} room={app.currentRoomId} />
        {:else}
          <MessageRow {msg} />
        {/if}
      {/each}
    {/if}
  </div>

  <Composer roomName={room?.name ?? app.currentRoomId} />
</section>

<style>
  .room {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface);
    min-width: 0;
  }
  .room-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 24px 14px 20px;
    border-bottom: 1px solid var(--border);
    min-height: 60px;
  }
  .title { display: flex; align-items: center; gap: 12px; }
  .rg { color: var(--text-3); display: grid; place-items: center; }
  .title h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { font-size: 12px; color: var(--text-3); margin-top: 1px; }
  .online { display: inline-flex; align-items: center; gap: 4px; color: var(--pos); }
  .odot { width: 6px; height: 6px; border-radius: 50%; background: var(--pos); }
  .actions { display: flex; gap: 4px; }
  .icon-btn {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-3);
    border-radius: var(--r-2);
    cursor: pointer;
  }
  .icon-btn:hover { background: var(--surface-2); color: var(--text); border-color: var(--border); }
  .room-body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 16px 0 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
  }
  .empty { margin: auto; max-width: 440px; text-align: center; padding: 40px 24px; }
  .empty-mark {
    width: 56px;
    height: 56px;
    border-radius: var(--r-4);
    display: grid;
    place-items: center;
    margin: 0 auto 16px;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--border);
  }
  .empty h2 { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  .empty p { margin: 0 0 8px; color: var(--text-2); line-height: 1.6; }
  .empty .muted { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
</style>

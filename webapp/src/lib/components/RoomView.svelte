<script lang="ts">
  import Icon from '../Icon.svelte'
  import MessageRow from './MessageRow.svelte'
  import ApprovalInlay from './ApprovalInlay.svelte'
  import InlayCard from '../inlay/InlayCard.svelte'
  import FileCard from './FileCard.svelte'
  import Composer from './Composer.svelte'
  import MembersModal from './MembersModal.svelte'
  import { app } from '../state.svelte'
  import { ui } from '../ui.svelte'
  import { roomStore } from '../rooms.svelte'
  import { identity } from '../identity.svelte'
  import { hex } from '../api'


  const room = $derived(roomStore.find(app.currentRoomId))
  const glyph = { icon: 'hash' }
  // No key means no membership. Say so instead of encrypting into the void.
  // Reads app.hasRoomKey (reactive) rather than localStorage directly, so a key
  // arriving via member_add re-enables the composer without a reload.
  const canPost = $derived(app.hasRoomKey)
  // A discoverable room we can see but haven't joined — we can ask in, versus a
  // room we belong to but hold no key for (an edge state: wait for the wrap).
  const discoverable = $derived(!!room && !room.joined)
  const myHex = $derived(identity.current ? hex(identity.current.memberPub) : '')
  const alreadyRequested = $derived(app.joinRequests.some((r) => r.pubHex === myHex))
  // Requests to ADMIT never include yourself — you can't admit your own request.
  const pendingToAdmit = $derived(app.joinRequests.filter((r) => r.pubHex !== myHex))
  let requesting = $state(false)
  let showMembers = $state(false)

  async function requestJoin() {
    requesting = true
    try {
      await app.requestJoin()
    } finally {
      requesting = false
    }
  }
</script>

<section class="room">
  <header class="room-header">
    <div class="title">
      <button class="icon-btn menu-btn" aria-label="Open navigation" onclick={() => ui.openNav()}>
        <Icon name="menu" />
      </button>
      {#if app.currentRoomId}
        <span class="rg"><Icon name={glyph.icon} size={16} /></span>
        <div>
          <h1>{room?.name ?? app.currentRoomId}</h1>
          <div class="sub">
            room
            {#if app.online.length > 0}
              · <span class="online"><span class="odot"></span>{app.online.length} online</span>
            {/if}
          </div>
        </div>
      {/if}
    </div>
    {#if app.currentRoomId}
      <div class="actions">
        <!-- Member management is only meaningful once you're actually in the room:
             a discoverer who only requested to join holds no key and can't add,
             rotate, or admit. Showing them the roster + admit UI (including their
             OWN pending request) is the confusing state we're avoiding. -->
        {#if canPost}
          <button
            class="icon-btn"
            title={pendingToAdmit.length > 0 ? `Members & keys — ${pendingToAdmit.length} waiting to join` : 'Members & keys'}
            aria-label="Members and keys"
            onclick={() => (showMembers = true)}
          >
            <Icon name="users" />
            {#if pendingToAdmit.length > 0}
              <span class="req-dot" aria-hidden="true">{pendingToAdmit.length}</span>
            {/if}
          </button>
          <button class="icon-btn" title="Info" aria-label="Info"><Icon name="info" /></button>
          <button class="icon-btn" title="More" aria-label="More"><Icon name="kebab" /></button>
        {/if}
      </div>
    {/if}
  </header>

  {#if showMembers}
    <MembersModal onclose={() => (showMembers = false)} />
  {/if}

  <div class="room-body">
    {#if !app.currentRoomId}
      <div class="empty">
        <div class="empty-mark"><Icon name="hash" size={22} /></div>
        <h2>No room selected</h2>
        <p>
          Create a room from the sidebar to start talking. Rooms aren't handed to you —
          each one exists because someone created it and added the people in it.
        </p>
      </div>
    {:else if !canPost}
      <!-- Honest states: we hold no key for this room, so we are not a member.
           Never silently mint one — that is what produced phantom rooms. -->
      <div class="empty">
        <div class="empty-mark"><Icon name="lock" size={22} /></div>
        {#if discoverable}
          <h2>You can see this room, but you're not in it</h2>
          <p>
            It's discoverable through your space, so you know it exists — but you hold no key,
            so its messages stay unreadable. Ask to join and an existing member can add you.
          </p>
          {#if alreadyRequested}
            <p class="muted">Request sent. A member of the room can now add your key.</p>
          {:else}
            <button class="join-btn" onclick={requestJoin} disabled={requesting}>
              {requesting ? 'Sending…' : 'Ask to join'}
            </button>
          {/if}
        {:else}
          <h2>You're not a member of this room</h2>
          <p>
            You don't hold a key for it, so its messages stay unreadable and you can't post.
            Someone already in the room has to add your member key.
          </p>
        {/if}
      </div>
    {:else if app.messages.length === 0}
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
        {:else if msg.file}
          <FileCard {msg} />
        {:else}
          <MessageRow {msg} />
        {/if}
      {/each}
    {/if}
  </div>

  {#if canPost}
    <Composer roomName={room?.name ?? app.currentRoomId} />
  {/if}
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
    position: relative;
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
  /* Pending join-request count on the members button. */
  .req-dot {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--accent, #2563eb);
    color: var(--accent-fg, #fff);
    font-size: 10px;
    font-weight: 700;
    font-family: var(--font-mono);
  }

  /* The drawer toggle only exists below the breakpoint, where the rail and
     room list are no longer on screen. */
  .menu-btn { display: none; }
  @media (max-width: 900px) {
    .menu-btn { display: grid; margin-right: 2px; }
    /* 32px is under the 44px touch-target floor; widen on pointer:coarse only
       so desktop density is unchanged. */
    .icon-btn { width: 40px; height: 40px; }
    .room-header { padding: 10px 12px; }
  }
  @media (pointer: coarse) {
    .icon-btn { min-width: 44px; min-height: 44px; }
  }
  .room-body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 16px 0 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
  }
  /* Children must keep their natural height. As flex items they default to
     flex-shrink: 1, so once the timeline overflows they get COMPRESSED instead
     of scrolled — and .inlay's overflow:hidden then clips the squeezed content.
     Chat rows are short enough to hide it; tall inlay cards lost whole rows
     (a poll's percentage, an approval's capability/scope labels). */
  .room-body > :global(*) {
    flex: 0 0 auto;
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
  .join-btn {
    margin-top: 6px;
    padding: 9px 16px;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    border: 0;
    border-radius: 8px;
    background: var(--accent, #2563eb);
    color: #fff;
    cursor: pointer;
  }
  .join-btn:disabled { opacity: 0.6; cursor: default; }
</style>

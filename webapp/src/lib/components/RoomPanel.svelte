<script lang="ts">
  // The room panel: standing furniture, not conversation.
  //
  // An inlay declared with surface: 'room_panel' belongs here rather than in the
  // timeline. The distinction is about lifetime, not looks — an agent's status
  // card is meant to be CURRENT, and anything current is useless once it has
  // scrolled away behind an afternoon of chat. Panels update in place via
  // inlay_update checkpoints, so the card a room shows is the agent's live state.
  import InlayCard from '../inlay/InlayCard.svelte'
  import type { PanelInlay } from '../state.svelte'
  import type { Action } from '../inlay/types'

  let {
    panels,
    room,
    memberHexes,
    onaction,
  }: {
    panels: PanelInlay[]
    room: string
    memberHexes?: string[]
    onaction?: (a: Action) => void
  } = $props()
</script>

<aside class="room-panel" aria-label="Room panel">
  {#each panels as p (p.idHex)}
    <div class="panel-item">
      <div class="panel-by">{p.author}</div>
      <InlayCard instance={p.instance} {room} {memberHexes} {onaction} />
    </div>
  {/each}
</aside>

<style>
  .room-panel {
    background: var(--surface-2);
    border-left: 1px solid var(--border);
    overflow-y: auto;
    min-height: 0;
    width: 320px;
    flex: 0 0 auto;
    padding: 14px 12px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .panel-item { display: flex; flex-direction: column; gap: 5px; }

  /* Panels carry no message row, so attribution has to live here — a standing
     card whose author is unnamed is exactly the kind of ambient UI that should
     make someone suspicious. */
  .panel-by {
    font: 500 10.5px/1 var(--font-mono);
    letter-spacing: 0.04em;
    color: var(--text-3);
    padding-left: 2px;
  }

  /* The card is already margin-boxed for the timeline; inside the panel it
     should fill the column. */
  .panel-item :global(.inlay) {
    margin: 0;
    max-width: none;
  }

  @media (max-width: 900px) {
    .room-panel { display: none; }
  }
</style>

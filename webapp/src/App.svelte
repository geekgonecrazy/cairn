<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import SpaceRail from './lib/components/SpaceRail.svelte'
  import RoomList from './lib/components/RoomList.svelte'
  import RoomView from './lib/components/RoomView.svelte'
  import { app } from './lib/state.svelte'

  onMount(() => app.init())
  onDestroy(() => app.dispose())
</script>

<div class="shell">
  <SpaceRail />
  <RoomList />
  <RoomView />
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: 56px 280px 1fr;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  @media (max-width: 900px) {
    .shell { grid-template-columns: 56px 1fr; }
  }
</style>

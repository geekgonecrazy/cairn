<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import SpaceRail from './lib/components/SpaceRail.svelte'
  import RoomList from './lib/components/RoomList.svelte'
  import RoomView from './lib/components/RoomView.svelte'
  import Onboarding from './lib/components/Onboarding.svelte'
  import DevicesModal from './lib/components/DevicesModal.svelte'
  import CreateSpaceModal from './lib/components/CreateSpaceModal.svelte'
  import { app } from './lib/state.svelte'
  import { ui } from './lib/ui.svelte'
  import { identity } from './lib/identity.svelte'

  onMount(() => {
    identity.load()
    app.init()
  })
  onDestroy(() => app.dispose())
</script>

{#if identity.ready && !identity.current}
  <Onboarding
    onready={(id) => {
      identity.set(id)
      app.reidentify() // pick up the device-scoped session key setup just minted
    }}
  />
{/if}

<!-- Under 900px the rail + room list leave the grid and become an overlay
     drawer: at 390px they would otherwise claim 336 of 390 available px. -->
<div class="shell" class:nav-open={ui.navOpen}>
  <nav class="nav" aria-label="Spaces and rooms">
    <SpaceRail />
    <RoomList />
  </nav>
  <button
    class="scrim"
    tabindex={ui.navOpen ? 0 : -1}
    aria-label="Close navigation"
    onclick={() => ui.closeNav()}
  ></button>
  <RoomView />
</div>

{#if ui.identityOpen}
  <DevicesModal onclose={() => ui.closeIdentity()} />
{/if}

{#if ui.createSpaceOpen}
  <CreateSpaceModal />
{/if}

<svelte:window
  onkeydown={(e) => {
    if (e.key !== 'Escape') return
    if (ui.createSpaceOpen) ui.closeCreateSpace()
    else if (ui.identityOpen) ui.closeIdentity()
    else ui.closeNav()
  }}
/>

<style>
  .shell {
    display: grid;
    grid-template-columns: 336px 1fr; /* 56 rail + 280 list */
    height: 100vh;
    height: 100dvh; /* mobile browser chrome shrinks the visual viewport */
    width: 100%;
    overflow: hidden;
  }

  .nav {
    display: grid;
    grid-template-columns: 56px 280px;
    min-height: 0;
  }

  .scrim { display: none; }

  @media (max-width: 900px) {
    .shell {
      grid-template-columns: 1fr; /* room view owns the viewport */
    }

    .nav {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 30;
      transform: translateX(-100%);
      transition: transform 160ms ease;
      box-shadow: 0 0 40px rgb(0 0 0 / 0.28);
    }
    .shell.nav-open .nav { transform: translateX(0); }

    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 20;
      border: 0;
      padding: 0;
      background: rgb(0 0 0 / 0.44);
      opacity: 0;
      pointer-events: none;
      transition: opacity 160ms ease;
    }
    .shell.nav-open .scrim { opacity: 1; pointer-events: auto; }
  }

  @media (prefers-reduced-motion: reduce) {
    .nav, .scrim { transition: none; }
  }
</style>

<script lang="ts">
  /**
   * The app frame: identity, navigation, and the two states that precede any board.
   *
   * Everything below the sign-in gate is a route now. `BoardScreen.svelte` used to hold the auth
   * guard, the onboarding, a `screen` enum, the card drawer, the palette and a six-section agents
   * modal in 1114 lines — which is why the address bar could not describe where you were.
   */
  import '../app.css';
  import { onMount } from 'svelte';
  import { app } from '$lib/stores/app.svelte';
  import Rail from '$lib/components/shell/Rail.svelte';
  import BottomNav from '$lib/components/shell/BottomNav.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import Landing from '$lib/components/Landing.svelte';
  import BrandMark from '$lib/components/BrandMark.svelte';

  let { children } = $props();

  onMount(() => {
    void app.init();
    return () => app.dispose();
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') app.closeCard();
  }}
/>

{#if app.authState === 'loading'}
  <main class="min-h-viewport safe-x flex flex-col items-center justify-center gap-3 text-center">
    <BrandMark class="size-7" />
    <div class="wordmark text-lg">superpipeline</div>
    <div class="mono text-muted-foreground flex items-center gap-2 text-xs"><span class="live-dot"></span>loading your boards…</div>
  </main>
{:else if app.authState === 'signed-out'}
  <Landing />
{:else}
  <div class="app-shell h-viewport flex overflow-hidden">
    <Rail />
    <div class="flex min-w-0 flex-1 flex-col">
      {@render children()}
      <BottomNav />
    </div>
  </div>
  <CommandPalette />
{/if}

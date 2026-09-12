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
  <main class="flex min-h-screen flex-col items-center justify-center gap-3 text-center">
    <svg class="arrowmark size-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 12h15" /><path d="M13 6l6 6-6 6" /><path d="M3 9l3 3-3 3" />
    </svg>
    <div class="wordmark text-lg">Kaambaan</div>
    <div class="mono text-muted-foreground flex items-center gap-2 text-xs"><span class="live-dot"></span>warming up the flight deck…</div>
  </main>
{:else if app.authState === 'signed-out'}
  <Landing />
{:else}
  <div class="flex h-screen overflow-hidden">
    <Rail />
    <div class="flex min-w-0 flex-1 flex-col">
      {@render children()}
      <BottomNav />
    </div>
  </div>
  <CommandPalette />
{/if}

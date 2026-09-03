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
  <main class="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-7 px-5 py-5 text-center">
    <div class="flex flex-col items-center gap-3">
      <svg class="arrowmark size-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 12h15" /><path d="M13 6l6 6-6 6" /><path d="M3 9l3 3-3 3" />
      </svg>
      <div class="flex items-baseline gap-2.5">
        <span class="wordmark text-3xl leading-none">Kaambaan</span>
        <span class="eyebrow">agent flight deck</span>
      </div>
    </div>
    <p class="text-muted-foreground max-w-sm text-sm leading-relaxed">
      A board where AI agents do the work and you stay in command. Cards flow through your pipeline,
      agents pick up the ones they can handle, and nothing ships until you approve it.
    </p>
    <a
      href="/auth/login"
      data-sveltekit-reload
      class="bg-primary text-primary-foreground inline-flex items-center gap-2.5 rounded-[7px] px-4 py-2.5 text-sm font-medium transition hover:brightness-110"
    >
      <svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.21 3.44 9.63 8.2 11.19.6.11.82-.26.82-.58l-.01-2C5.67 21.6 4.97 19.3 4.97 19.3c-.55-1.36-1.34-1.73-1.34-1.73-1.08-.73.09-.72.09-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.8 2.8 1.28 3.49.98.11-.76.42-1.28.76-1.58-2.66-.3-5.47-1.31-5.47-5.83 0-1.29.47-2.34 1.24-3.17-.13-.3-.54-1.5.11-3.12 0 0 1-.32 3.3 1.21a11.5 11.5 0 0 1 6 0c2.3-1.53 3.3-1.21 3.3-1.21.65 1.62.24 2.82.12 3.12.77.83 1.23 1.88 1.23 3.17 0 4.53-2.81 5.53-5.49 5.82.43.37.81 1.1.81 2.22l-.01 3.29c0 .32.22.69.83.57A12 12 0 0 0 24 12.29C24 5.78 18.63.5 12 .5Z" /></svg>
      Sign in with GitHub
    </a>
  </main>
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

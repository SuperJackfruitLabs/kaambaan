<script lang="ts">
  /**
   * The front door. It is a redirect, not a screen.
   *
   * `app.init()` resolves which board to open — the remembered one, then the first one — and sets
   * `needsBoard` when there is none. This route only turns that answer into an address, so that
   * every other screen can assume a board id in the URL.
   */
  import { goto } from '$app/navigation';
  import { app } from '$lib/stores/app.svelte';
  import Onboarding from '$lib/components/Onboarding.svelte';

  $effect(() => {
    if (app.authState === 'ready' && app.boardId) void goto(`/b/${app.boardId}`, { replaceState: true });
  });
</script>

{#if app.needsBoard}
  <Onboarding />
{:else}
  <main class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
    <div class="mono text-muted-foreground flex items-center gap-2 text-xs"><span class="live-dot"></span>finding your board…</div>
  </main>
{/if}

<script lang="ts">
  /**
   * A board, and everything that is true while you are in it.
   *
   * The board is opened here rather than in each page, so switching between Plan and Operate does
   * not tear down the WebSocket and re-fetch the snapshot — they are two views of one board, not
   * two boards.
   *
   * Isolation is inherited rather than added: `boardStub` names the Durable Object
   * `${tenantId}:${boardId}`, so a board id belonging to another tenant resolves to a different,
   * uninitialised object and the API answers 404 — the same answer a board that never existed
   * gets. A board id in a URL is therefore not an existence oracle.
   */
  import { page } from '$app/state';
  import { replaceState } from '$app/navigation';
  import { app } from '$lib/stores/app.svelte';
  import BoardHeader from '$lib/components/shell/BoardHeader.svelte';
  import CardDrawer from '$lib/components/CardDrawer.svelte';

  let { children } = $props();

  const boardId = $derived(page.params.boardId!);

  $effect(() => {
    const id = boardId;
    if (app.authState !== 'ready' || !id || app.boardId === id) return;
    void app.openBoard(id);
  });

  /**
   * Keep the address bar honest.
   *
   * Without this half a link works when followed and starts lying the moment the reader clicks
   * anything — which is worse than no routing at all, because the URL now looks authoritative.
   * It lived in `BoardScreen.svelte` and came back here when that file was retired; the e2e suite
   * caught its absence, which is the entire reason that assertion exists.
   *
   * `replaceState` rather than `goto`: opening a card is not a navigation a reader expects Back to
   * undo one step at a time. Back should leave the board, not walk through every card they glanced
   * at.
   */
  $effect(() => {
    if (!app.board) return;
    const want = app.openCardId ? `/b/${boardId}/c/${app.openCardId}` : `/b/${boardId}`;
    if (location.pathname !== want && !location.pathname.includes('/operate') && !location.pathname.includes('/settings')) {
      replaceState(want, {});
    }
  });
</script>

{#if app.board}
  <BoardHeader />
  <main class="min-h-0 flex-1 overflow-auto">
    {@render children()}
  </main>
  {#if app.openCardId}
    <CardDrawer />
  {/if}
{:else}
  <main class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
    <svg class="arrowmark size-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 12h15" /><path d="M13 6l6 6-6 6" /><path d="M3 9l3 3-3 3" />
    </svg>
    <div class="mono text-muted-foreground flex items-center gap-2 text-xs">
      <span class="live-dot"></span>{app.error ?? 'establishing link to the board…'}
    </div>
  </main>
{/if}

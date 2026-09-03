<script lang="ts">
  /**
   * Four things, and a budget.
   *
   * This row is the surface that failed. At 390px its predecessor was 813px wide with
   * `flex-wrap: nowrap` and no horizontal scroll, so seven controls were clipped off the page —
   * not scrolled to, gone. The fix was not to rearrange it but to give it fewer reasons to exist:
   * the view toggle and filter moved into Plan, spend and notifications into Operate, agents into
   * Workspace.
   *
   * **Nothing may be added here without removing something.** Four items is the budget: the board,
   * whether we are connected, search, and the one primary action.
   */
  import { app } from '$lib/stores/app.svelte';
  import BoardSwitcher from './BoardSwitcher.svelte';
  import ComposeSheet from './ComposeSheet.svelte';

  let composing = $state(false);

  // The palette asks for the composer from a place that cannot open it. A counter rather than a
  // flag, so asking twice in a row is two requests.
  $effect(() => {
    if (app.composeRequest === 0) return;
    void app.composeRequest;
    composing = true;
  });
</script>

<header class="border-border bg-surface flex items-center gap-2 border-b px-3 py-2">
  <BoardSwitcher />

  <span class="flex-1"></span>

  <span
    class="mono hidden items-center gap-1.5 text-[11px] min-[420px]:inline-flex"
    style="color:{app.connected ? 'var(--live)' : 'var(--muted)'}"
    title={app.connected ? 'Live — changes arrive as they happen' : 'Reconnecting…'}
  >
    <span class="size-[6px] rounded-full" style="background:currentColor"></span>
    {app.connected ? 'live' : 'offline'}
  </span>

  <button
    onclick={() => app.toggleCmdk()}
    aria-label="Search"
    title="Search — ⌘K"
    class="text-muted-foreground hover:text-foreground hover:bg-inset tap rounded-[8px]"
  >
    <svg class="size-[17px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
  </button>

  <button
    onclick={() => (composing = true)}
    class="bg-primary text-primary-foreground flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-sm font-medium transition hover:brightness-110"
    style="min-height:var(--tap)"
  >
    <span aria-hidden="true">+</span>
    <span class="hidden min-[560px]:inline">New card</span>
    <span class="sr-only min-[560px]:hidden">New card</span>
  </button>
</header>

<ComposeSheet open={composing} onClose={() => (composing = false)} />

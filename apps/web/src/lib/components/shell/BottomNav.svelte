<script lang="ts">
  /**
   * The phone's navigation — the fix for the audit's severe finding.
   *
   * At 390px the old topbar row was 813px wide with `flex-wrap: nowrap` and no scroll, so seven
   * controls were clipped off the page: the view toggle, the filter, spend, notifications, search,
   * and **Agents** — the only door to capabilities, members, tokens and the fleet link. Every
   * management surface built that week did not exist on a phone.
   *
   * Three destinations, each at least 50px tall, which is comfortably past the 44px coarse-pointer
   * floor. Rendered only below 900px; above it the rail takes over.
   */
  import { page } from '$app/state';
  import { app } from '$lib/stores/app.svelte';

  const boardId = $derived(app.boardId);
  const here = $derived(
    page.url.pathname.startsWith('/workspace')
      ? 'workspace'
      : page.url.pathname.includes('/operate')
        ? 'operate'
        : 'plan',
  );
  const attention = $derived(app.needsYou().length);
</script>

<nav
  class="border-border bg-surface grid grid-cols-3 border-t px-2 pt-1 min-[900px]:hidden"
  style="padding-bottom:calc(0.25rem + env(safe-area-inset-bottom, 0px))"
  aria-label="Main"
>
  <a
    href={boardId ? `/b/${boardId}` : '/'}
    aria-current={here === 'plan' ? 'page' : undefined}
    class="mono flex min-h-[50px] flex-col items-center justify-center gap-1 rounded-[9px] text-[10px] {here === 'plan' ? 'text-marigold' : 'text-muted-foreground'}"
  >
    <svg class="size-[19px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></svg>
    Plan
  </a>

  <a
    href={boardId ? `/b/${boardId}/operate` : '/'}
    aria-current={here === 'operate' ? 'page' : undefined}
    class="mono relative flex min-h-[50px] flex-col items-center justify-center gap-1 rounded-[9px] text-[10px] {here === 'operate' ? 'text-marigold' : 'text-muted-foreground'}"
  >
    <svg class="size-[19px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 12h4l2.5-6 4 13 2.5-7H21" /></svg>
    Operate
    {#if attention > 0}
      <span class="bg-coral absolute top-2 left-1/2 ml-1.5 size-[7px] rounded-full" aria-hidden="true"></span>
      <span class="sr-only">{attention} needing attention</span>
    {/if}
  </a>

  <a
    href="/workspace/agents"
    aria-current={here === 'workspace' ? 'page' : undefined}
    class="mono flex min-h-[50px] flex-col items-center justify-center gap-1 rounded-[9px] text-[10px] {here === 'workspace' ? 'text-marigold' : 'text-muted-foreground'}"
  >
    <svg class="size-[19px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="3" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></svg>
    Workspace
  </a>
</nav>

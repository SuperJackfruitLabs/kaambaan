<script lang="ts">
  /**
   * Workspace — who and what may act here.
   *
   * Was six unrelated sections in one scrolling modal: the fleet link, the agent list, "Connect to
   * AgentPod", the capability registry, People, New agent, and the AgentPod picker. Scrolled to
   * the middle there was no heading in view to say where you were and no way to jump.
   *
   * Configuration is a place you go, not a sheet you scroll.
   */
  import { page } from '$app/state';
  import { app } from '$lib/stores/app.svelte';

  let { children } = $props();

  const TABS = [
    { id: 'needs-you', label: 'Needs you' },
    { id: 'agents', label: 'Agents' },
    { id: 'capabilities', label: 'Capabilities' },
    { id: 'labels', label: 'Labels' },
    { id: 'people', label: 'People' },
    { id: 'connections', label: 'Connections' },
  ];
  const here = $derived(page.params.tab ?? 'agents');
</script>

<header class="border-border bg-surface border-b">
  <div class="mx-auto flex w-full max-w-5xl items-center gap-2 px-3 py-2">
    <a href={app.boardId ? `/b/${app.boardId}` : '/'} class="text-muted-foreground hover:text-foreground mono inline-flex items-center gap-1 text-[11px]" style="min-height:var(--tap)">
      <span aria-hidden="true">←</span> Board
    </a>
    <h1 class="ml-1 text-sm font-semibold">Workspace</h1>
  </div>
</header>

<div class="border-border border-b">
  <div class="mx-auto flex w-full max-w-5xl gap-0.5 overflow-x-auto px-3 pt-2" role="tablist">
    {#each TABS as t (t.id)}
      <a
        href="/workspace/{t.id}"
        role="tab"
        aria-selected={here === t.id}
        class="rounded-t-[8px] px-3 text-sm whitespace-nowrap {here === t.id ? 'text-marigold shadow-[inset_0_-2px_0_var(--marigold)]' : 'text-muted-foreground hover:text-foreground'}"
        style="min-height:var(--tap);display:inline-flex;align-items:center"
      >{t.label}</a>
    {/each}
  </div>
</div>

<!-- The tabs and the content share one column, so the tab you are on sits over what it shows. At
     1920px the tabs started at x=96 and the content at x=630, in a 768px column (audit 2026-10-07). -->
<main class="min-h-0 flex-1 overflow-auto">
  <div class="touch-form mx-auto w-full max-w-5xl p-3">
    {@render children()}
  </div>
</main>

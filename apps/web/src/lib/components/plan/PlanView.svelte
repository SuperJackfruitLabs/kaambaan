<script lang="ts">
  /**
   * Plan — the shape of the work.
   *
   * Owns what used to sit in the topbar and could not fit there: the view toggle and the filter.
   * Both belong to this mode rather than to the app, which is half of why the header stopped
   * overflowing.
   */
  import { app } from '$lib/stores/app.svelte';
  import BoardKanban from '$lib/components/board/BoardKanban.svelte';
  import ListView from './ListView.svelte';
  import ProjectView from './ProjectView.svelte';
  import FilterBar from './FilterBar.svelte';
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="border-border flex items-center gap-2 border-b px-3 py-2">
    <div class="border-border inline-flex overflow-hidden rounded-[7px] border text-xs">
      <button
        onclick={() => app.setView('board')}
        aria-pressed={app.view === 'board'}
        class="mono px-2.5 {app.view === 'board' ? 'bg-marigold text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
        style="min-height:var(--tap)"
      >Board</button>
      <button
        onclick={() => app.setView('list')}
        aria-pressed={app.view === 'list'}
        class="mono border-border border-l px-2.5 {app.view === 'list' ? 'bg-marigold text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
        style="min-height:var(--tap)"
      >List</button>
      <button
        onclick={() => app.setView('projects')}
        aria-pressed={app.view === 'projects'}
        class="mono border-border border-l px-2.5 {app.view === 'projects' ? 'bg-marigold text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
        style="min-height:var(--tap)"
      >Projects</button>
    </div>
    <!-- The card filters (state/owner/label/project…) describe a list of CARDS, which this view
         stops being the moment "Projects" is selected — no `FilterBar` for a screen with no cards
         in it. -->
    {#if app.view !== 'projects'}
      <FilterBar />
    {/if}
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#if app.view === 'board'}
      <BoardKanban />
    {:else if app.view === 'list'}
      <ListView />
    {:else}
      <ProjectView />
    {/if}
  </div>
</div>

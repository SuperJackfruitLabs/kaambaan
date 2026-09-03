<script lang="ts">
  /**
   * Board settings, as a route.
   *
   * It was a modal, which was defensible when it held a rename field and a webhook secret. It now
   * holds the pipeline editor — add, reorder, retitle, WIP limits, gates, owners — which is not
   * modal-sized work.
   *
   * Budget caps are deliberately NOT here. They moved to Operate › Spend, beside the figures they
   * cap, because a control belongs next to its consequence.
   */
  import { app } from '$lib/stores/app.svelte';
  import BoardSettings from '$lib/components/BoardSettings.svelte';
  import { goto } from '$app/navigation';
</script>

<div class="p-3">
  <a href="/b/{app.boardId}" class="text-muted-foreground hover:text-foreground mono mb-2 inline-flex items-center gap-1 text-[11px]" style="min-height:var(--tap)">
    <span aria-hidden="true">←</span> Board
  </a>
  {#if app.board}
    <BoardSettings open={true} board={app.board} onClose={() => goto(`/b/${app.boardId}`)} onChanged={() => void app.refresh()} />
  {/if}
</div>

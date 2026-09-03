<script lang="ts">
  /**
   * A card, by address — Plan with its drawer open.
   *
   * The drawer is rendered by the board layout from `app.openCardId`, so this route's whole job is
   * to set it. A card the snapshot does not contain leaves it closed rather than opening an empty
   * drawer, which reads as a broken card instead of a stale link.
   */
  import { page } from '$app/state';
  import { app } from '$lib/stores/app.svelte';
  import PlanView from '$lib/components/plan/PlanView.svelte';

  $effect(() => {
    const cardId = page.params.cardId;
    if (!cardId || !app.board) return;
    app.openCardId = app.board.cards.some((c) => c.id === cardId) ? cardId : null;
  });
</script>

<PlanView />

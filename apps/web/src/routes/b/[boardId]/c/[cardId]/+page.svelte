<script lang="ts">
  /**
   * A card, by address — what a Matrix approval links to.
   *
   * A card id that is not on this board opens the board and clears the
   * selection rather than erroring. Stale links are the normal case here: a
   * gate lives in a room forever, and the card it names can be deleted,
   * archived, or simply finished.
   */
  import { page } from '$app/state';
  import BoardScreen from '$lib/components/BoardScreen.svelte';
</script>

<BoardScreen routeBoardId={page.params.boardId} routeCardId={page.params.cardId} />

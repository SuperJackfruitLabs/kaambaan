<script lang="ts">
  /**
   * A board, by address.
   *
   * Isolation is inherited rather than added here: `boardStub` names the
   * Durable Object `${tenantId}:${boardId}`, so a board id belonging to
   * another tenant resolves to a different, uninitialised object and the API
   * answers 404 — the same answer a board that never existed gets. A card id
   * in a URL is therefore not an existence oracle.
   */
  import { page } from '$app/state';
  import BoardScreen from '$lib/components/BoardScreen.svelte';
</script>

<BoardScreen routeBoardId={page.params.boardId} />

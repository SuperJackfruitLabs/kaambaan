<script lang="ts">
  /**
   * Attention as an object, not a bell — for this board.
   *
   * Each row is driven by the reason the card gives (`needsHuman`), says what to do, and carries
   * the action: Resume for a card its agent blocked or the breaker stopped, Answer for a question,
   * Review (which opens the card — nothing is approved blind from a list), Staff an agent for a
   * refused dispatch, Move for a card sitting in a stage nothing claims. The same rows, across every
   * board, are at /workspace/needs-you.
   */
  import { app } from '$lib/stores/app.svelte';
  import { moveCard, resumeCard } from '$lib/api';
  import { itemsFromBoard, type AttentionItem } from '$lib/components/attention/attention';
  import { refusalOf } from '$lib/components/attention/refusal';
  import NeedsYouList from '$lib/components/attention/NeedsYouList.svelte';

  const items = $derived(app.board ? itemsFromBoard(app.board, app.agents) : []);

  async function resume(it: AttentionItem, comment: string): Promise<string | null> {
    const refused = await refusalOf(await resumeCard(it.boardId, it.cardId, comment));
    if (!refused) await app.refresh();
    return refused;
  }

  async function move(it: AttentionItem, stageKey: string): Promise<string | null> {
    const refused = await refusalOf(await moveCard(it.boardId, it.cardId, stageKey));
    if (!refused) await app.refresh();
    return refused;
  }
</script>

<NeedsYouList
  {items}
  stagesFor={() => app.board?.stages ?? []}
  onOpen={(it) => app.openCard(it.cardId)}
  onResume={resume}
  onMove={move}
>
  {#snippet header()}
    <a href="/workspace/needs-you" class="text-muted-foreground hover:text-foreground mono text-[11px]">All boards →</a>
  {/snippet}
</NeedsYouList>

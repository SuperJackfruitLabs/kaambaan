<script lang="ts">
  /**
   * Everything waiting on you, across every board in the workspace — one list, from
   * `GET /v1/stale?attention=1`. The per-board panel in Operate shows the same rows for one board.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { listAttention, resumeCard, type StaleCard } from '$lib/api';
  import { itemsFromStale, type AttentionItem } from '$lib/components/attention/attention';
  import { refusalOf } from '$lib/components/attention/refusal';
  import NeedsYouList from '$lib/components/attention/NeedsYouList.svelte';

  let cards = $state<StaleCard[] | null>(null);
  let unanswered = $state(0);
  let error = $state<string | null>(null);
  const items = $derived(cards ? itemsFromStale(cards) : []);

  async function load(): Promise<void> {
    try {
      const res = await listAttention();
      cards = res.cards;
      unanswered = res.boardsUnanswered;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function resume(it: AttentionItem, comment: string): Promise<string | null> {
    const refused = await refusalOf(await resumeCard(it.boardId, it.cardId, comment));
    if (!refused) await load();
    return refused;
  }

  onMount(() => void load());
</script>

{#if error}
  <p class="text-coral text-sm" role="alert">Could not load what is waiting: {error}</p>
{:else if cards === null}
  <p class="text-muted-foreground text-sm">Loading…</p>
{:else}
  <NeedsYouList
    {items}
    showBoard
    empty="Nothing on any board is waiting on you."
    onOpen={(it) => void goto(`/b/${it.boardId}/c/${it.cardId}`)}
    onResume={resume}
  >
    {#snippet header()}
      <button onclick={() => void load()} class="text-muted-foreground hover:text-foreground mono text-[11px]" style="min-height:var(--tap)">Refresh</button>
    {/snippet}
  </NeedsYouList>
  {#if unanswered > 0}
    <p class="text-muted-foreground mt-2 text-xs">{unanswered} board{unanswered === 1 ? '' : 's'} did not answer; this list may be incomplete.</p>
  {/if}
{/if}

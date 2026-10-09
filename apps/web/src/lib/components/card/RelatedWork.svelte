<!-- apps/web/src/lib/components/card/RelatedWork.svelte -->
<script lang="ts">
  import { libraryRef, outcomeWord, relatedForCard, sentenceFor, type RelatedLite } from '$lib/superlibrary';

  let { cardId }: { cardId: string } = $props();
  let items = $state<RelatedLite[]>([]);
  let phase = $state<'loading' | 'ok' | 'unavailable'>('loading');
  let why = $state('');
  let attempt = $state(0);

  $effect(() => {
    const id = cardId;
    void attempt;
    let live = true;
    phase = 'loading';
    relatedForCard(id)
      .then((r) => { if (live) { items = r; phase = 'ok'; } })
      .catch((e: unknown) => { if (live) { why = sentenceFor(e); phase = 'unavailable'; } });
    return () => { live = false; };
  });
</script>

<!-- Text from other people's and agents' work: rendered as text, never as markup. -->
<section class="sec" aria-labelledby="related-work-h">
  <div id="related-work-h" class="sec-h eyebrow">related prior work</div>
  {#if phase === 'loading'}
    <p class="text-muted-foreground text-xs" role="status">Looking in Superlibrary…</p>
  {:else if phase === 'unavailable'}
    <p class="text-muted-foreground text-xs">Related prior work is not available. {why}</p>
    <button type="button" class="border-border min-h-[44px] rounded-[5px] border px-2 text-xs" onclick={() => attempt++}>Try again</button>
  {:else if items.length === 0}
    <p class="text-muted-foreground text-xs">Nothing related in Superlibrary yet.</p>
  {:else}
    <ul class="grid grid-cols-[minmax(0,1fr)] gap-2">
      {#each items as r (r.itemId)}
        <li class="border-border min-w-0 rounded-[6px] border px-2 py-1.5">
          <div class="flex flex-wrap items-baseline gap-2">
            <span class="mono text-[10px] uppercase tracking-wide">{outcomeWord(r.outcome)}</span>
            {#if libraryRef(r.url)}
              <a href={r.url} target="_blank" rel="noopener noreferrer" class="flex min-h-[44px] min-w-0 flex-1 items-center text-xs font-medium [overflow-wrap:anywhere] hover:underline">{r.title || r.itemId}</a>
            {:else}
              <span class="min-w-0 flex-1 text-xs font-medium [overflow-wrap:anywhere]">{r.title || r.itemId}</span>
            {/if}
          </div>
          {#if r.snippet}<p class="text-muted-foreground mt-1 line-clamp-3 text-xs [overflow-wrap:anywhere]">{r.snippet}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

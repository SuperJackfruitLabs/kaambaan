<script lang="ts">
  /**
   * A Needs-you list: a heading with its count, then one row per card waiting on a person. Shared by
   * the board's Operate panel and the workspace view, so a card reads the same in both.
   */
  import type { Snippet } from 'svelte';
  import type { Stage } from '$lib/api';
  import type { AttentionItem } from './attention';
  import AttentionRow from './AttentionRow.svelte';

  let {
    items,
    stagesFor = () => [],
    showBoard = false,
    empty = 'Nothing is waiting on you.',
    onOpen,
    onResume,
    onMove,
    header,
  }: {
    items: AttentionItem[];
    stagesFor?: (item: AttentionItem) => Stage[];
    showBoard?: boolean;
    empty?: string;
    onOpen: (item: AttentionItem) => void;
    onResume: (item: AttentionItem, comment: string) => Promise<string | null>;
    onMove?: (item: AttentionItem, stageKey: string) => Promise<string | null>;
    header?: Snippet;
  } = $props();
</script>

<section class="border-border bg-surface overflow-hidden rounded-[12px] border">
  <div class="border-border flex flex-wrap items-center gap-2 border-b px-3.5 py-2.5">
    <h2 class="text-sm font-semibold">Needs you</h2>
    <span class="mono text-[11px]" style="color:{items.length > 0 ? 'var(--coral)' : 'var(--muted)'}">{items.length}</span>
    {#if header}<div class="ml-auto">{@render header()}</div>{/if}
  </div>
  {#if items.length === 0}
    <p class="text-muted-foreground px-3.5 py-4 text-sm">{empty}</p>
  {:else}
    {#each items as it (it.id)}
      <AttentionRow item={it} stages={stagesFor(it)} {showBoard} {onOpen} {onResume} {onMove} />
    {/each}
  {/if}
</section>

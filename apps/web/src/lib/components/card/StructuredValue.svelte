<!--
  One value, drawn by its shape. Shared by the card's Details and by every handoff the drawer shows.

  - prose: wrapped text, `backticked` spans as inline code, http(s) URLs as links
  - a string that is wholly a JSON object/array: read as that value (agents do store them so)
  - array of scalars: a bullet list; array with any group in it: numbered groups
  - object: labelled groups, each nested level under a subtle left rule
  - boolean/number plain; null and empties as "—"
  - deeper than MAX_DEPTH: folded behind "Show more" (never stringified); a long list: first
    LIST_PREVIEW items and "Show all N"

  Everything is interpolated as text — there is no `{@html}` here, so a key or value containing
  markup shows the markup.
-->
<script lang="ts">
  import Self from './StructuredValue.svelte';
  import { humaniseKey, inlineParts, isEmptyValue, isPlainObject, listWindow, nestedEntries, normaliseValue, shouldCollapse } from './spec-details';

  let { value, depth = 0, testid }: { value: unknown; depth?: number; testid?: string } = $props();

  const v = $derived(normaliseValue(value));
  const isGroup = (x: unknown) => Array.isArray(x) || isPlainObject(x);

  let expanded = $state(false);
  let showAll = $state(false);

  function size(x: unknown): string {
    if (Array.isArray(x)) return `${x.length} ${x.length === 1 ? 'item' : 'items'}`;
    const n = Object.keys(x as object).length;
    return `${n} ${n === 1 ? 'field' : 'fields'}`;
  }
</script>

{#if isEmptyValue(v)}
  <span class="sv-empty text-muted-foreground text-[12.5px]" data-testid={testid}>—</span>
{:else if shouldCollapse(v, depth)}
  <div data-testid={testid}>
    <button type="button" class="sv-more text-[11.5px]" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
      {expanded ? 'Show less' : `Show more · ${size(v)}`}
    </button>
    {#if expanded}
      <!-- A fresh frame: the next six levels draw in full, and fold again past them. -->
      <div class="mt-1"><Self value={v} depth={0} /></div>
    {/if}
  </div>
{:else if Array.isArray(v)}
  {@const items = v as unknown[]}
  {@const groups = items.some((x) => isGroup(normaliseValue(x)))}
  {@const win = listWindow(items, showAll)}
  {#if groups}
    <ol class="sv-groups flex flex-col gap-1.5" data-testid={testid}>
      {#each win.shown as item, i (i)}
        <li class="sv-group border-border flex min-w-0 gap-2 rounded-[7px] border px-2.5 py-2">
          <span class="sv-num mono text-muted-foreground shrink-0 text-[10.5px] leading-[1.6rem]" aria-hidden="true">{i + 1}.</span>
          <div class="min-w-0 flex-1"><Self value={item} depth={depth + 1} /></div>
        </li>
      {/each}
    </ol>
  {:else}
    <ul class="sv-list list-disc space-y-0.5 pl-4" data-testid={testid}>
      {#each win.shown as item, i (i)}
        <li class="min-w-0"><Self value={item} depth={depth + 1} /></li>
      {/each}
    </ul>
  {/if}
  {#if win.hidden > 0 || showAll}
    <button type="button" class="sv-more mt-1 text-[11.5px]" onclick={() => (showAll = !showAll)}>
      {showAll ? 'Show fewer' : `Show all ${items.length}`}
    </button>
  {/if}
{:else if isPlainObject(v)}
  <dl class="sv-dl flex flex-col gap-1.5" data-testid={testid}>
    {#each nestedEntries(v) as e (e.key)}
      {@const inner = normaliseValue(e.value)}
      <div class="min-w-0">
        <dt class="sv-k text-muted-foreground text-[11px] font-medium">{humaniseKey(e.key)}</dt>
        <dd class="min-w-0 {isGroup(inner) && !isEmptyValue(inner) ? 'sv-nest mt-1 border-l pl-2.5' : ''}">
          <Self value={inner} depth={depth + 1} />
        </dd>
      </div>
    {/each}
  </dl>
{:else if typeof v === 'string'}
  {@const parts = inlineParts(v)}
  <p class="sv-text text-[12.5px] leading-relaxed whitespace-pre-wrap" data-testid={testid}>{#each parts as p, i (i)}{#if p.code}<code class="sv-code mono">{p.text}</code>{:else if p.href}<a class="sv-link underline underline-offset-2" href={p.href} target="_blank" rel="noreferrer noopener">{p.text}</a>{:else}{p.text}{/if}{/each}</p>
{:else}
  <span class="sv-text mono text-[12.5px]" data-testid={testid}>{String(v)}</span>
{/if}

<style>
  .sv-text,
  .sv-k {
    color: var(--text);
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .sv-k {
    color: var(--muted);
  }
  .sv-code {
    font-size: 0.92em;
    padding: 0 0.3em;
    border-radius: 4px;
    background: var(--inset);
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .sv-link {
    color: var(--marigold);
    overflow-wrap: anywhere;
  }
  .sv-nest {
    border-color: var(--line);
  }
  .sv-more {
    color: var(--marigold);
    min-height: 24px;
  }
  .sv-more:hover {
    text-decoration: underline;
  }
</style>

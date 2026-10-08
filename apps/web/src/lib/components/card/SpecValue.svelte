<!--
  One spec value, drawn by its shape: prose as wrapped text with its http(s) URLs linked, arrays
  as bullet lists, objects as labelled groups (recursively, to MAX_DEPTH), booleans and numbers
  plain. Everything is interpolated as text — a spec string containing markup shows the markup.
-->
<script lang="ts">
  import Self from './SpecValue.svelte';
  import { MAX_DEPTH, compactJson, humaniseKey, isPlainObject, splitLinks, visibleEntries } from './spec-details';

  let { value, depth = 0, testid }: { value: unknown; depth?: number; testid?: string } = $props();

  const nested = $derived(Array.isArray(value) || isPlainObject(value));
</script>

{#if nested && depth >= MAX_DEPTH}
  <code class="spec-json mono block text-[11.5px] text-muted-foreground" data-testid={testid}>{compactJson(value)}</code>
{:else if Array.isArray(value)}
  {@const items = value.filter((v) => v !== null && v !== undefined)}
  {@const groups = items.some((v) => Array.isArray(v) || isPlainObject(v))}
  <ul class="spec-list {groups ? 'spec-list-groups flex flex-col gap-1.5' : 'list-disc pl-4 space-y-0.5'}" data-testid={testid}>
    {#each items as item, i (i)}
      <li class={groups ? 'spec-group border-border rounded-[7px] border px-2.5 py-2' : ''}>
        <Self value={item} depth={depth + 1} />
      </li>
    {/each}
  </ul>
{:else if isPlainObject(value)}
  <dl class="spec-dl flex flex-col gap-1.5" data-testid={testid}>
    {#each visibleEntries(value) as e (e.key)}
      <div class="min-w-0">
        <dt class="spec-k text-muted-foreground text-[11px] font-medium">{humaniseKey(e.key)}</dt>
        <dd class="min-w-0 {Array.isArray(e.value) || isPlainObject(e.value) ? 'spec-nest mt-1 border-l pl-2.5' : ''}">
          <Self value={e.value} depth={depth + 1} />
        </dd>
      </div>
    {/each}
  </dl>
{:else if typeof value === 'string'}
  {@const parts = splitLinks(value)}
  <p class="spec-text text-[12.5px] leading-relaxed whitespace-pre-wrap" data-testid={testid}>{#if parts.length === 1 && !parts[0]!.href}{value}{:else}{#each parts as p, i (i)}{#if p.href}<a class="spec-link underline underline-offset-2" href={p.href} target="_blank" rel="noreferrer noopener">{p.text}</a>{:else}{p.text}{/if}{/each}{/if}</p>
{:else}
  <span class="spec-text mono text-[12.5px]" data-testid={testid}>{String(value)}</span>
{/if}

<style>
  .spec-text {
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .spec-json {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .spec-link {
    color: var(--marigold);
  }
  .spec-nest {
    border-color: var(--line);
  }
</style>

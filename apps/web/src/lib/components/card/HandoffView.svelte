<!--
  A handoff, as a document: each top-level key a humanised label, each value drawn by
  StructuredValue (the same renderer as the card's Details), and the raw JSON one tap away.

  Used for each stage's "handed on" and for the card's carried handoff — which, after a refused
  completion, holds `feedback` and `refusedHandoff`, both drawn the same way.
-->
<script lang="ts">
  import RawJson from './RawJson.svelte';
  import StructuredValue from './StructuredValue.svelte';
  import { humaniseKey, isEmptyValue, isPlainObject, nestedEntries, normaliseValue } from './spec-details';

  let { handoff, testid }: { handoff: unknown; testid?: string } = $props();

  const v = $derived(normaliseValue(handoff));
</script>

{#if !isEmptyValue(v)}
  <div class="min-w-0" data-testid={testid}>
    <div data-structured class="min-w-0">
      {#if isPlainObject(v)}
        <dl class="flex flex-col gap-2.5">
          {#each nestedEntries(v) as e (e.key)}
            {@const inner = normaliseValue(e.value)}
            <div class="min-w-0">
              <dt class="hv-k text-muted-foreground mb-0.5 text-[11px] font-medium">{humaniseKey(e.key)}</dt>
              <dd class="min-w-0 {(Array.isArray(inner) || isPlainObject(inner)) && !isEmptyValue(inner) ? 'hv-nest mt-1 border-l pl-2.5' : ''}">
                <StructuredValue value={inner} depth={0} />
              </dd>
            </div>
          {/each}
        </dl>
      {:else}
        <StructuredValue value={v} depth={0} />
      {/if}
    </div>
    <RawJson value={handoff} />
  </div>
{/if}

<style>
  .hv-k {
    overflow-wrap: anywhere;
  }
  .hv-nest {
    border-color: var(--line);
  }
</style>

<!--
  "Details": every spec field the card drawer does not render in its own section.

  The agent working a card receives the WHOLE spec, so the person reviewing the card should be able
  to read the whole spec too — not only description, plan and acceptance criteria. Native
  `<details>` for the disclosure, as the activity stream does: keyboard-operable and announced as
  expandable for free. Open by default when there is no description above it (then this IS the
  brief), or when the spec is short enough not to bury the rest of the drawer.
-->
<script lang="ts">
  import RawJson from './RawJson.svelte';
  import StructuredValue from './StructuredValue.svelte';
  import { humaniseKey, isLongSpec, isPlainObject, normaliseValue, specDetailEntries } from './spec-details';

  let { spec, hasDescription }: { spec: Record<string, unknown> | null | undefined; hasDescription: boolean } = $props();

  const entries = $derived(specDetailEntries(spec));
  const startOpen = $derived(!hasDescription || !isLongSpec(entries));
</script>

{#if entries.length > 0}
  <section class="sec" data-testid="spec-details">
    <details open={startOpen} class="spec-details">
      <summary class="sec-h eyebrow cursor-pointer select-none" style="min-height:var(--tap);margin-bottom:0">
        details
        <span class="ml-auto normal-case tracking-normal">{entries.length} {entries.length === 1 ? 'field' : 'fields'}</span>
      </summary>
      <dl class="bg-inset border-border mt-2 flex flex-col gap-3 rounded-[7px] border px-3.5 py-3">
        {#each entries as e (e.key)}
          {@const inner = normaliseValue(e.value)}
          <div class="min-w-0">
            <dt class="spec-k text-muted-foreground mb-0.5 text-[11px] font-medium">{humaniseKey(e.key)}</dt>
            <dd class="min-w-0 {isPlainObject(inner) ? 'spec-nest mt-1 border-l pl-2.5' : Array.isArray(inner) ? 'mt-1' : ''}">
              <StructuredValue value={inner} depth={0} testid={`spec-value-${e.key}`} />
            </dd>
          </div>
        {/each}
      </dl>
      <RawJson value={Object.fromEntries(entries.map((e) => [e.key, e.value]))} />
    </details>
  </section>
{/if}

<style>
  .spec-k {
    overflow-wrap: anywhere;
  }
  .spec-nest {
    border-color: var(--line);
  }
  .spec-details > summary {
    list-style: none;
  }
  .spec-details > summary::-webkit-details-marker {
    display: none;
  }
  .spec-details > summary::before {
    content: '▸';
    display: inline-block;
    transition: transform 0.15s ease;
  }
  .spec-details[open] > summary::before {
    transform: rotate(90deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .spec-details > summary::before {
      transition: none;
    }
  }
</style>

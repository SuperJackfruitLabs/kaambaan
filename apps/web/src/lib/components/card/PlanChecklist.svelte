<!--
  "Agent plan": card.spec.plan as a checklist with a progress bar. Accepts every plan shape
  `normalisePlan` reads; renders nothing when no step has text.
-->
<script lang="ts">
  import { normalisePlan } from './plan';

  let { plan }: { plan: unknown } = $props();

  const steps = $derived(normalisePlan(plan));
  const done = $derived(steps ? steps.filter((s) => s.done).length : 0);
  const pct = $derived(steps && steps.length > 0 ? Math.round((done / steps.length) * 100) : 0);
</script>

{#if steps}
  <section class="sec" data-testid="plan-checklist">
    <div class="sec-h eyebrow flex items-center gap-2">
      agent plan
      <span class="ml-auto" style="color:var(--live)">{pct}%</span>
    </div>
    <div class="plan flex flex-col gap-0.5">
      {#each steps as step, i (i)}
        <div class="step flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-sm {step.done ? 'step-done' : ''}">
          <span class="step-box flex size-4 shrink-0 items-center justify-center rounded-[5px] border text-[10px] {step.done ? 'step-box-done' : 'border-border'}">
            {#if step.done}✓{/if}
          </span>
          <span class="step-t {step.done ? 'text-muted-foreground line-through' : ''}">{step.text}</span>
        </div>
      {/each}
    </div>
    <!-- rollup bar -->
    <div class="rollup mt-2 h-[5px] overflow-hidden rounded-full bg-inset">
      <div class="h-full rounded-full transition-all duration-1000" style="width:{pct}%;background:var(--live)"></div>
    </div>
    <div class="eyebrow mt-1.5">{done} / {steps.length} steps · {pct}%</div>
  </section>
{/if}

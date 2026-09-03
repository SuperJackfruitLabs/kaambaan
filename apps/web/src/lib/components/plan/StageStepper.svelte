<script lang="ts">
  /**
   * The pipeline, on a phone.
   *
   * The alternative was to collapse the lanes into a list grouped by stage, which reads more
   * easily and throws away the thing the product is: left-to-right flow through waypoints. So the
   * lanes survive — one per screen, snapped — and this carries the order and the counts that a
   * single visible lane cannot.
   *
   * `IntersectionObserver` rather than a scroll handler: the question is "which lane is on
   * screen", which is what it answers natively, and a scroll handler would recompute geometry on
   * every frame to reach the same answer.
   */
  import type { Stage } from '$lib/api';
  import { app } from '$lib/stores/app.svelte';

  let { stages, container }: { stages: Stage[]; container: HTMLElement | null } = $props();

  let current = $state(0);

  const counts = $derived.by(() => {
    const cards = app.filteredCards();
    return Object.fromEntries(stages.map((s) => [s.key, cards.filter((c) => c.currentStageKey === s.key).length]));
  });

  $effect(() => {
    if (!container) return;
    const lanes = [...container.querySelectorAll<HTMLElement>('[data-lane]')];
    if (lanes.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const i = lanes.indexOf(e.target as HTMLElement);
            if (i >= 0) current = i;
          }
        }
      },
      { root: container, threshold: 0.6 },
    );
    for (const l of lanes) io.observe(l);
    return () => io.disconnect();
  });

  function jump(i: number): void {
    const lane = container?.querySelectorAll<HTMLElement>('[data-lane]')[i];
    lane?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
</script>

<div class="border-border flex gap-1.5 overflow-x-auto border-b px-3 py-2 min-[900px]:hidden" role="tablist" aria-label="Stage" style="scrollbar-width:none">
  {#each stages as s, i (s.key)}
    <button
      role="tab"
      aria-selected={current === i}
      onclick={() => jump(i)}
      class="mono inline-flex shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 text-xs whitespace-nowrap
             {current === i ? 'bg-accent-bg text-marigold' : 'text-muted-foreground'}"
      style="min-height:var(--tap)"
    >
      {s.name}
      <span class="opacity-70">{counts[s.key] ?? 0}{#if s.wipLimit !== undefined}/{s.wipLimit}{/if}</span>
    </button>
  {/each}
</div>

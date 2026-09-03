<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import { columnDropTarget } from '$lib/dnd';
  import CardTile from './CardTile.svelte';
  import StageStepper from '$lib/components/plan/StageStepper.svelte';

  /** The lane scroller, so the stepper can observe which lane is on screen and scroll to one. */
  let scroller = $state<HTMLElement | null>(null);

  // local drag-over tracking (no external state needed)
  let overStage = $state<string | null>(null);

  function cardsInStage(stageKey: string) {
    return app.filteredCards().filter((c) => c.currentStageKey === stageKey);
  }
</script>

{#if app.board}
  {@const board = app.board}
  {@const stages = [...board.stages].sort((a, b) => a.order - b.order)}

  <!-- the directed flight path: stages are waypoints, work flows →
       No own overflow: the full-height screen container (in +page.svelte) is the scroller, so
       horizontal scroll works across the whole viewport height, not just the lanes' height.
       min-h-full makes the board fill the available height (drop targets + scroll region). -->
  <StageStepper stages={stages} container={scroller} />

  <!-- Below 900px each lane is the width of the viewport and snaps, so the pipeline is paged
       rather than squeezed. Above it, lanes sit side by side as before. -->
  <div
    bind:this={scroller}
    class="flex min-h-full items-start overflow-x-auto px-3 pt-3 pb-6 [scroll-snap-type:x_mandatory] min-[900px]:px-4 min-[900px]:pt-4 min-[900px]:[scroll-snap-type:none]"
  >
    {#each stages as stage, i (stage.key)}
      {@const cards = cardsInStage(stage.key)}
      {@const overLimit = stage.wipLimit !== undefined && cards.length >= stage.wipLimit}

      {#if i > 0}
        <!-- The flow arrow, thinner. It used to take ~50px between every pair of 288px lanes,
             which together put four of six stages on a 1440px screen with the fourth cut through
             its own title. The waypoint language stays; it just stops costing a sixth of a lane. -->
        <div class="flow-arrow hidden px-1.5 min-[900px]:block">
          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </div>
      {/if}

      <section
        data-lane
        class="lane w-[calc(100vw-1.5rem)] shrink-0 rounded-[12px] p-2 [scroll-snap-align:center] min-[900px]:w-[264px] min-[900px]:[scroll-snap-align:none] transition-[box-shadow,background-color] {overStage === stage.key ? 'ring-marigold bg-card ring-2' : 'bg-card/40'}"
        use:columnDropTarget={{
          stageKey: stage.key,
          onDrop: (cardId) => app.moveCard(cardId, stage.key),
          onOver: (o) => (overStage = o ? stage.key : overStage === stage.key ? null : overStage),
        }}
      >
        <!-- waypoint header -->
        <div class="lane-head flex h-[30px] items-center gap-2 px-1.5">
          <span class="wordmark text-[13px] tracking-wide">{stage.name}</span>
          <span class="mono text-xs {overLimit ? 'text-coral' : 'text-muted-foreground'}">
            {cards.length}{#if stage.wipLimit !== undefined}/{stage.wipLimit}{/if}
          </span>
          <span class="ml-auto flex items-center gap-1.5">
            {#if stage.gate === 'approval'}
              <span class="eyebrow text-coral" title="Approval gate">gate</span>
            {/if}
            {#if stage.routing === 'manager'}
              <span class="eyebrow" title="Manager routing">mgr</span>
            {/if}
          </span>
        </div>

        <!-- cards -->
        <div class="lane-body mt-1.5 flex min-h-12 flex-col gap-2.5">
          {#if cards.length === 0}
            <!-- One quiet strip. Five full-height AWAITING WORK boxes meant the majority of the
                 screen was spent saying "empty" five times at full width. -->
            <div class="eyebrow border-border/60 mx-1 grid h-[34px] place-items-center rounded-[8px] border border-dashed text-center opacity-60">
              empty
            </div>
          {/if}
          {#each cards as card (card.id)}
            <CardTile {card} />
          {/each}
        </div>
      </section>
    {/each}
  </div>
{/if}

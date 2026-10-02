<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import { columnDropTarget } from '$lib/dnd';
  import CardTile from './CardTile.svelte';
  import StageStepper from '$lib/components/plan/StageStepper.svelte';
  import { blockedCountInStage } from './board-counts';
  import { childCountsByParent } from './card-children';
  import { stageOwner } from './stage-owner';

  /** The lane scroller, so the stepper can observe which lane is on screen and scroll to one. */
  let scroller = $state<HTMLElement | null>(null);

  // local drag-over tracking (no external state needed)
  let overStage = $state<string | null>(null);

  function cardsInStage(stageKey: string) {
    return app.filteredCards().filter((c) => c.currentStageKey === stageKey);
  }

  /**
   * Every card's child count, by parent id — built ONCE per render here, not once per tile.
   *
   * A tile used to scan `app.board.cards` itself (`cards.filter(c => c.parentCardId === id)`)
   * inside its own `$derived`, which is O(n) work repeated for every one of the n tiles on the
   * board — O(n²) overall. Computed once and handed down, same fix the server side already made
   * with `rowToCard`'s `pre` argument (Task 14) and for the same reason.
   */
  const childCounts = $derived(childCountsByParent(app.board?.cards ?? []));
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
      {@const blocked = blockedCountInStage(cards)}
      {@const owner = stageOwner(stage, app.agents)}

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

      <!--
        A NAMED region. An unnamed `<section>` has no role at all, so eight columns arrived in the
        accessibility tree as eight anonymous `generic` boxes — a board with nothing to navigate
        by, neither heading nor landmark.
      -->
      <section
        aria-labelledby="lane-{stage.key}"
        data-lane
        class="lane w-[calc(100vw-1.5rem)] shrink-0 rounded-[12px] p-2 [scroll-snap-align:center] min-[900px]:w-[264px] min-[900px]:[scroll-snap-align:none] transition-[box-shadow,background-color] {overStage === stage.key ? 'ring-marigold bg-card ring-2' : 'bg-card/40'}"
        use:columnDropTarget={{
          stageKey: stage.key,
          onDrop: (cardId) => app.moveCard(cardId, stage.key),
          onOver: (o) => (overStage = o ? stage.key : overStage === stage.key ? null : overStage),
        }}
      >
        <!-- waypoint header
             `min-h` + `flex-wrap` rather than a fixed height: a long stage name plus the WIP count
             plus the blocked count (below) can run out of room on a phone-width lane, and a fixed
             30px height would clip the overflow instead of letting it wrap to a second line. -->
        <div class="lane-head flex min-h-[30px] flex-wrap items-center gap-x-2 gap-y-0.5 px-1.5 py-0.5">
          <h2 id="lane-{stage.key}" class="wordmark text-[13px] font-normal tracking-wide">{stage.name}</h2>
          <span class="mono text-xs {overLimit ? 'text-coral' : 'text-muted-foreground'}">
            {cards.length}{#if stage.wipLimit !== undefined}/{stage.wipLimit}{/if}
          </span>
          {#if blocked > 0}
            <!--
              The only place the claim-query's exclusion of blocked cards is ever explained: a
              blocked card is EXCLUDED from claim, not refused, so an agent reports "no work" while
              this column visibly holds cards. Count is from `blockedBy.length > 0` (Step 2) — the
              same field the tile's ⛔ badge reads, never a second "is this blocked" expression.
            -->
            <span
              class="mono text-coral shrink-0 text-[11px]"
              title="{blocked} of {cards.length} card{cards.length === 1 ? '' : 's'} here {blocked === 1 ? 'is' : 'are'} blocked — held back by an unresolved same-board blocker, excluded from claim"
            >⛔ {blocked} blocked</span>
          {/if}
          <span class="ml-auto flex items-center gap-1.5">
            {#if stage.gate === 'approval'}
              <span class="eyebrow text-coral" title="Approval gate">gate</span>
            {/if}
            {#if stage.routing === 'manager'}
              <span class="eyebrow" title="Manager routing">mgr</span>
            {/if}
          </span>
        </div>

        <!--
          Who works this lane.
          ────────────────────
          A second line rather than more chips on the first: the head already wraps on a phone, and
          the owner is the thing a reader scans down a board for, so it wants its own row at a fixed
          place in each lane.

          A capability nobody DECLARES is marked, because a card in such a lane sits in `submitted`
          forever and looks queued — the commonest cause of "why is nothing happening", and until now
          indistinguishable from a lane nobody had got to. The wording is "declares", not "can claim":
          the board does not load the implication graph, so an agent may still qualify, and the title
          says so rather than letting a reader conclude the lane is dead.
        -->
        <div class="lane-owner px-1.5">
          {#if owner.undeclared}
            <span class="text-coral" title={owner.caveat}>⚠ {owner.label} — nobody declares it</span>
          {:else}
            <span class="text-muted-foreground">{owner.label}</span>
            {#if owner.declaredBy.length > 0}
              <span
                class="text-muted-foreground/70"
                title={owner.declaredBy.join(', ')}
              >· {owner.declaredBy.length === 1 ? owner.declaredBy[0] : `${owner.declaredBy.length} agents`}</span>
            {/if}
          {/if}
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
            <CardTile {card} {childCounts} />
          {/each}
        </div>
      </section>
    {/each}
  </div>
{/if}

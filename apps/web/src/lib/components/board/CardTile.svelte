<script lang="ts">
  import { displayAgent } from '$lib/names';
  import type { Card, Reference } from '$lib/api';
  import { resolveGate, type GateDecision } from '$lib/api';
  import { app } from '$lib/stores/app.svelte';
  import { agentColor, initialOf } from '$lib/components/agentColor';
  import { cardDraggable } from '$lib/dnd';
  import { Button } from '$lib/components/ui/button';
  import { overdue } from './card-due';
  import { enforcedBadge } from './card-blocked';
  import { childCounter } from './card-children';
  import { cardProvenance } from './card-provenance';

  interface Props {
    card: Card;
    /**
     * Every card's child count, by parent id — built ONCE in `BoardKanban` and handed to every
     * tile, rather than each tile scanning the whole board's card list itself (O(n²) across a
     * board with many cards). See `card-children.ts#childCountsByParent`.
     */
    childCounts: Map<string, number>;
  }

  const { card, childCounts }: Props = $props();

  // Gate is reactive — reads from app store
  const gate = $derived(app.gateForCard(card.id));
  const question = $derived(app.elicitationForCard(card.id));
  const refs = $derived(app.referencesForCard(card.id));
  const firstRef = $derived(refs[0] ?? null);

  /**
   * Priority as a 3px left edge stripe rather than a chip.
   *
   * A chip competes with the title for the first thing the eye lands on; a stripe is readable
   * straight down a column without being read at all. Absent priority renders nothing, rather
   * than a third chip saying "P3".
   */
  const priColour = $derived(card.priority === 1 ? 'var(--coral)' : card.priority === 2 ? 'var(--marigold)' : null);

  /**
   * The ⛔ badge and the `open/total` sub-task counter (Task 17b, Step 1 / 1c).
   *
   * `blocked` is built ONLY from `card.blockedBy` — the server's own claim-query predicate
   * (Task 17c). Never re-derived from anything else here: a badge computed independently of it is
   * a badge that can eventually disagree with `claim_card`. The tile never shows the cross-board
   * `⚑ Blocked (advisory)` badge — that reads `externalLinks`, which nothing on the board grid
   * fetches per-tile; it lives in the drawer's Links section instead, where the data is already
   * being fetched.
   *
   * `children` pairs `openChildCount` (server-computed) with a sibling count looked up from
   * `childCounts` (the `Props` above) — a card with open children is never "Blocked by" anything,
   * so the two badges can both be present and never fight over which one to show.
   */
  const blocked = $derived(enforcedBadge(card.blockedBy));
  const totalChildren = $derived(childCounts.get(card.id) ?? 0);
  const children = $derived(childCounter(card.openChildCount, totalChildren));

  // Reference chip helpers (ported from page.svelte)
  const SUB_STATE_LABELS: Record<string, string> = {
    draft_pr_open: 'draft',
    pr_open: 'open',
    agent_iterating: 'iterating',
    awaiting_review: 'review',
    merged: 'merged',
    closed: 'closed',
    agent_working: 'working',
    issue_open: 'open',
    issue_closed: 'closed',
  };

  function subStateLabel(ref: Reference): string | null {
    const s = ref.metadata?.subState;
    return typeof s === 'string' ? (SUB_STATE_LABELS[s] ?? s) : null;
  }

  function refLabel(ref: Reference): string {
    if (ref.sourceType === 'pull_request') {
      const num = ref.externalId?.split('#')[1];
      return `PR${num ? ` #${num}` : ''}`.trim();
    }
    if (ref.sourceType === 'issue') {
      const num = ref.externalId?.split('#')[1];
      return `Issue${num ? ` #${num}` : ''}`.trim();
    }
    if (ref.sourceType === 'repo') return ref.externalId ?? 'repo';
    return ref.title ?? ref.sourceType;
  }

  function subStateClass(sub: string): string {
    if (sub === 'draft' || sub === 'draft_pr_open') return 'refchip-st refchip-st-draft';
    if (sub === 'open' || sub === 'ready' || sub === 'review' || sub === 'iterating' || sub === 'working') return 'refchip-st refchip-st-ready';
    if (sub === 'merged') return 'refchip-st refchip-st-merged';
    return 'refchip-st refchip-st-draft';
  }

  function safeHref(url: string): string | null {
    return /^https?:\/\//i.test(url) ? url : null;
  }

  function fmtUsd(n: number): string {
    return `$${n.toFixed(2)}`;
  }

  /**
   * Cost against the card's budget cap.
   *
   * This used to compute `costUsd / (costUsd * 1.5)` — arithmetic that is 67% for every card with
   * any cost at all, regardless of budget. It looked like a spend gauge and measured nothing. A
   * bar is only meaningful against a ceiling, so when there is no cap there is no bar: the figure
   * alone is the honest reading.
   */
  const cardCap = $derived(app.board?.usage.cardUsdCap ?? null);
  const costBarPct = $derived(
    cardCap && cardCap > 0 ? Math.min(100, Math.round((card.costUsd / cardCap) * 100)) : null,
  );

  // Delegate avatar. `agents.icon_url` has existed since migration 0001 and was read by nothing;
  // the coloured initial stays the fallback, which is what most agents will always have.
  const delegate = $derived(app.agents.find((a) => a.id === card.delegateAgentId) ?? null);
  const avatarColor = $derived(agentColor(card.delegateAgentId));
  const avatarInitial = $derived(
    card.delegateAgentId ? initialOf(card.delegateAgentId).toUpperCase() : null,
  );

  /**
   * Who asked for this card. Shown on the TILE and not only in the drawer, because a board full of
   * cards is where someone notices that an agent has queued twenty things; the drawer is where they
   * go afterwards.
   *
   * Rendered only when an AGENT queued it, which keeps the promise the meta row below makes: the
   * board's default state — a person queued this, nobody has picked it up — stays its quietest. A
   * "queued by Rakesh" chip on all three hundred cards would be the loudest thing on the board and
   * would say nothing.
   */
  const provenance = $derived(cardProvenance(card, app.members, app.agents));
  const queuerInitial = $derived(
    provenance.agent ? initialOf(provenance.agent.id).toUpperCase() : null,
  );

  /**
   * At most three chips plus "+N" — a tile is scanned, not read. An id with no catalogue entry
   * (deleted since it was applied — Task 4's permissive deletion) renders nothing rather than a
   * blank or broken chip.
   */
  const labelChips = $derived.by(() => {
    const byId = app.labelById();
    return card.labels.map((id) => byId.get(id)).filter((l): l is { name: string; colour: string } => l !== undefined);
  });
  const visibleLabelChips = $derived(labelChips.slice(0, 3));
  const extraLabelCount = $derived(Math.max(0, labelChips.length - 3));

  // Due date is `dueAt`, its own column — not `spec.due`. Overdue is a state worth showing: a date
  // rendered in the same grey as everything else says when, and never says "and that has passed".
  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = $derived(overdue(card.dueAt, card.state, today));

  function handleClick() {
    app.openCard(card.id);
  }

  /**
   * Moving a card was mouse-only — drag and drop with no keyboard or menu alternative — so the
   * board's central action was unavailable to keyboard and assistive-technology users.
   *
   * `Alt` + arrow rather than a bare arrow: bare arrows are how a keyboard user moves BETWEEN
   * cards, and stealing them to move the card itself would make the board impossible to read.
   */
  const orderedStages = $derived([...(app.board?.stages ?? [])].sort((a, b) => a.order - b.order));
  const stageIndex = $derived(orderedStages.findIndex((s) => s.key === card.currentStageKey));
  let moveMenuOpen = $state(false);
  let moveAnnouncement = $state('');

  async function moveTo(stageKey: string): Promise<void> {
    const target = orderedStages.find((s) => s.key === stageKey);
    if (!target || stageKey === card.currentStageKey) return;
    moveMenuOpen = false;
    await app.moveCard(card.id, stageKey);
    // Said out loud, because a keyboard user gets no visual feedback from a card that moved to a
    // column they cannot see. A refusal (a WIP limit) already lands in the error bar.
    moveAnnouncement = app.error ? '' : `${card.title} moved to ${target.name}`;
  }

  function shiftStage(by: number): void {
    const next = orderedStages[stageIndex + by];
    if (next) void moveTo(next.key);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      app.openCard(card.id);
      return;
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      shiftStage(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      moveMenuOpen = !moveMenuOpen;
    }
  }

  // Gate quick-actions (approve / request_changes / reject) shown directly on the tile
  // so the operator can act without opening the drawer — matches the gates.spec.ts expectation.
  async function onGateResolve(e: MouseEvent, decision: GateDecision): Promise<void> {
    e.stopPropagation(); // don't open the drawer
    const bid = app.boardId;
    const g = gate;
    if (!bid || !g) return;
    const res = await resolveGate(bid, g.id, decision);
    if (res.ok) {
      app.closeCard(); // close drawer if open for this card
      await app.refresh();
    }
  }
</script>

<!--
  The tile is a CONTAINER, not a button.

  It used to be `role="button"` wrapping a real `<button>` (move) and, when the card carried a
  reference, an `<a>`. An element with a button role may not contain interactive descendants:
  the role is a promise the markup cannot keep, and assistive technology may not expose the
  controls inside it at all.

  The whole-tile click survives, because the title button below is stretched over the tile with
  a pseudo-element. Everything else that is interactive sits above it on the z-axis, so the
  reference chip and the move control keep behaving exactly as they did.
-->
<div
  use:cardDraggable={{ cardId: card.id }}
  class="tile bg-surface border-border group relative rounded-[10px] border p-3 text-left cursor-grab active:cursor-grabbing {gate ? 'tile-gate' : ''}"
>
  <!-- What just happened, for a reader who cannot see the column the card landed in. -->
  <span aria-live="polite" class="sr-only">{moveAnnouncement}</span>

  <!--
    The menu alternative to dragging. Reachable by keyboard (M, or Tab to the control) and by a
    pointer that cannot drag — a touch screen, a trackpad the user finds hard to hold.
  -->
  <div class="absolute top-2 right-2 z-10">
    <button
      onclick={(e) => { e.stopPropagation(); moveMenuOpen = !moveMenuOpen; }}
      aria-label="Move {card.title} to another stage"
      aria-expanded={moveMenuOpen}
      title="Move to…"
      class="text-muted-foreground hover:text-foreground tap mono rounded-[6px] text-[11px] leading-none opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
      style="opacity:{moveMenuOpen ? 1 : undefined}"
    >⇄</button>
    {#if moveMenuOpen}
      <div
        role="menu"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); moveMenuOpen = false; } }}
        class="bg-surface border-border absolute top-full right-0 z-20 mt-1 w-40 rounded-[8px] border py-1 shadow-xl"
      >
        {#each orderedStages as s (s.key)}
          <button
            role="menuitem"
            onclick={() => void moveTo(s.key)}
            disabled={s.key === card.currentStageKey}
            class="hover:bg-inset block w-full px-2.5 py-1 text-left text-xs disabled:opacity-40"
          >{s.name}{s.key === card.currentStageKey ? ' · here' : ''}</button>
        {/each}
      </div>
    {/if}
  </div>
  {#if priColour}
    <span class="absolute top-0 bottom-0 left-0 w-[3px]" style="background:{priColour}" aria-hidden="true"></span>
    <span class="sr-only">Priority {card.priority}</span>
  {/if}

  <!-- row1: title + live dot -->
  <div class="row1 mb-2 flex items-start gap-2">
    <button
      type="button"
      onclick={handleClick}
      onkeydown={handleKeydown}
      aria-label="{card.title}, in {orderedStages[stageIndex]?.name ?? card.currentStageKey}. Enter to open, M to move, Alt with left or right arrow to move between stages."
      data-stretch-target
      data-card-open={card.id}
      class="tile-open flex-1 text-left text-[13.5px] font-medium leading-snug"
    >{card.title}</button>
    {#if card.state === 'working'}
      <span class="live-dot mt-1 shrink-0" title="Agent working"></span>
    {/if}
  </div>

  <!-- blocked badge + sub-task counter — the ⛔ badge is the highest-priority signal on the tile
       after the title, so it sits right under row1 rather than buried in the meta row. -->
  {#if blocked || children}
    <div class="mb-2 flex flex-wrap items-center gap-1.5">
      {#if blocked}
        <span class="blk-pill" title={blocked.tooltip}>{blocked.glyph} {blocked.label}</span>
      {/if}
      {#if children}
        <span class="child-pill" title="{children.open} of {children.total} sub-tasks still open">{children.open}/{children.total}</span>
      {/if}
    </div>
  {/if}

  <!-- labels -->
  {#if labelChips.length > 0}
    <div class="mb-2 flex flex-wrap gap-1">
      {#each visibleLabelChips as lbl (lbl.name)}
        <span class="lbl-pill" style="border-color:{lbl.colour}; color:{lbl.colour}">{lbl.name}</span>
      {/each}
      {#if extraLabelCount > 0}
        <span class="lbl-pill" title="{extraLabelCount} more label{extraLabelCount === 1 ? '' : 's'}">+{extraLabelCount}</span>
      {/if}
    </div>
  {/if}

  <!-- reference chip (first ref only) -->
  {#if firstRef}
    {@const sub = subStateLabel(firstRef)}
    {@const href = safeHref(firstRef.url)}
    {#if href}
      <a
        {href}
        target="_blank"
        rel="noreferrer"
        title={firstRef.url}
        onclick={(e) => e.stopPropagation()}
        class="refchip mb-1.5 block w-fit hover:border-marigold/50"
      >
        {refLabel(firstRef)}{#if sub}&nbsp;<span class={subStateClass(sub)}>{sub}</span>{/if}
      </a>
    {:else}
      <div class="refchip mb-1.5 w-fit">
        {refLabel(firstRef)}{#if sub}&nbsp;<span class={subStateClass(sub)}>{sub}</span>{/if}
      </div>
    {/if}
  {/if}

  <!-- meta row: avatar, owner, cost, due -->
  <div class="meta flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
    <!-- delegate avatar -->
    <!--
      One avatar slot, for the agent doing the work, and nothing at all when nobody is.

      There used to be two: this one, and a second showing the owner's initial — almost always the
      same letter on every card. Beside them, the word UNASSIGNED in capitals, which made the
      absence of an agent the most repeated and loudest thing on the board. The board's default
      state is that nobody has picked a card up; it should be its quietest.
    -->
    {#if card.delegateAgentId && delegate?.iconUrl}
      <img src={delegate.iconUrl} alt="" title={delegate.name} class="size-5 shrink-0 rounded-full object-cover" />
    {:else if card.delegateAgentId && avatarInitial}
      <span
        class="inline-grid size-5 shrink-0 place-items-center rounded-full font-mono text-[9px] font-semibold"
        style="background:{avatarColor}; color: #0f1118"
        title={delegate?.name ?? card.delegateAgentId}
      >{avatarInitial}</span>
    {:else}
      <span class="text-muted-foreground" aria-hidden="true">—</span>
    {/if}

    <!--
      Queued by an agent. Not a hover title alone: the audit requirement is that the operator can
      see which cards they did not ask for while scanning the board, and a fact only reachable by
      pointing at it is a fact the board does not show.
    -->
    {#if provenance.byAgent}
      <span class="queuedchip queuedchip-tile" title={`Queued by ${provenance.queuedByName}, not by you`}>
        {#if provenance.agent?.iconUrl}
          <img src={provenance.agent.iconUrl} alt="" class="size-3.5 shrink-0 rounded-full object-cover" />
        {:else if queuerInitial}
          <span
            class="inline-grid size-3.5 shrink-0 place-items-center rounded-full text-[8px] font-semibold"
            style="background:{agentColor(provenance.agent?.id ?? null)}; color: #0f1118"
            aria-hidden="true"
          >{queuerInitial}</span>
        {/if}
        <span class="truncate">asked by {provenance.queuedByName}</span>
      </span>
    {/if}

    <span class="spacer ml-auto"></span>

    <!-- cost -->
    {#if card.costUsd > 0}
      <span class={card.overBudget ? 'text-coral' : ''} title="Agent cost on this card">
        {fmtUsd(card.costUsd)}
      </span>
    {/if}

    <!-- due -->
    {#if card.dueAt}
      <span class={isOverdue ? 'text-coral' : ''} title={isOverdue ? `Due ${card.dueAt} — overdue` : `Due ${card.dueAt}`}>· {card.dueAt}{isOverdue ? ' ⚠' : ''}</span>
    {/if}

  </div>

  <!-- cost bar — only where there is a cap for it to be a fraction OF -->
  {#if card.costUsd > 0 && costBarPct !== null}
    <div class="costbar" title="{fmtUsd(card.costUsd)} of the {fmtUsd(cardCap!)} card cap">
      <span
        class="costbar-fill {card.overBudget ? 'costbar-fill-over' : ''}"
        style="width:{card.overBudget ? 100 : costBarPct}%"
      ></span>
    </div>
  {/if}

  <!-- an agent is blocked on a question: say so on the tile, and open the drawer to answer it -->
  {#if question}
    <div class="mt-2.5">
      <Button
        size="sm"
        variant="outline"
        onclick={(e: MouseEvent) => { e.stopPropagation(); app.openCard(card.id); }}
      >⚑ Answer {displayAgent(question.agentId, app.agents)}</Button>
    </div>
  {/if}

  <!-- gate quick-actions: Approve / Request changes / Reject — visible directly on the tile -->
  {#if gate}
    <div class="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Gate actions">
      {#each (gate.options.length > 0 ? gate.options : [
        { name: 'approve', title: 'Approve', interactive: false },
        { name: 'request_changes', title: 'Request changes', interactive: true },
        { name: 'reject', title: 'Reject', interactive: false },
      ]) as opt (opt.name)}
        {#if opt.name === 'approve'}
          <Button size="sm" onclick={(e: MouseEvent) => onGateResolve(e, 'approve')}>{opt.title}</Button>
        {:else if opt.name === 'request_changes'}
          <Button size="sm" variant="outline" onclick={() => app.openCard(card.id)}>{opt.title}</Button>
        {:else if opt.name === 'reject'}
          <Button size="sm" variant="ghost" onclick={(e: MouseEvent) => onGateResolve(e, 'reject')}>{opt.title}</Button>
        {/if}
      {/each}
    </div>
  {/if}
</div>

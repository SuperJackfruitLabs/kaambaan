<script lang="ts">
  import type { Card, Reference } from '$lib/api';
  import { resolveGate, type GateDecision } from '$lib/api';
  import { app } from '$lib/stores/app.svelte';
  import { agentColor, initialOf } from '$lib/components/agentColor';
  import { cardDraggable } from '$lib/dnd';
  import { Button } from '$lib/components/ui/button';

  interface Props {
    card: Card;
  }

  const { card }: Props = $props();

  // Gate is reactive — reads from app store
  const gate = $derived(app.gateForCard(card.id));
  const question = $derived(app.elicitationForCard(card.id));
  const refs = $derived(app.referencesForCard(card.id));
  const firstRef = $derived(refs[0] ?? null);

  // Priority chip class
  function priClass(p: number): string {
    if (p === 1) return 'pri-chip pri-chip-1';
    if (p === 2) return 'pri-chip pri-chip-2';
    return 'pri-chip pri-chip-3';
  }

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

  // Delegate avatar
  const avatarColor = $derived(agentColor(card.delegateAgentId));
  const avatarInitial = $derived(
    card.delegateAgentId ? initialOf(card.delegateAgentId).toUpperCase() : null,
  );

  // Labels from spec
  const labels = $derived(
    Array.isArray(card.spec?.labels) ? (card.spec.labels as string[]) : [],
  );

  // Due date from spec. Overdue is a state worth showing: a date rendered in the same grey as
  // everything else says when, and never says "and that has passed".
  const due = $derived(
    typeof card.spec?.due === 'string' ? card.spec.due : null,
  );
  const overdue = $derived(
    due !== null && card.state !== 'completed' && new Date(`${due}T23:59:59`).getTime() < Date.now(),
  );

  function handleClick() {
    app.openCard(card.id);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      app.openCard(card.id);
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

<div
  use:cardDraggable={{ cardId: card.id }}
  role="button"
  tabindex="0"
  aria-label="Open {card.title}"
  onclick={handleClick}
  onkeydown={handleKeydown}
  class="tile bg-surface border-border cursor-grab rounded-[10px] border p-3 text-left active:cursor-grabbing {gate ? 'tile-gate' : ''}"
>
  <!-- row1: priority chip + title + live dot -->
  <div class="row1 mb-2 flex items-start gap-2">
    {#if card.priority > 0}
      <span class={priClass(card.priority)}>P{card.priority}</span>
    {/if}
    <span class="flex-1 text-[13.5px] font-medium leading-snug">{card.title}</span>
    {#if card.state === 'working'}
      <span class="live-dot mt-1 shrink-0" title="Agent working"></span>
    {/if}
  </div>

  <!-- labels -->
  {#if labels.length > 0}
    <div class="mb-2 flex flex-wrap gap-1">
      {#each labels as lbl (lbl)}
        <span class="lbl-pill">{lbl}</span>
      {/each}
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
    {#if card.delegateAgentId && avatarInitial}
      <span
        class="inline-grid size-5 shrink-0 place-items-center rounded-full font-mono text-[9px] font-semibold"
        style="background:{avatarColor}; color: #0f1118"
        title={card.delegateAgentId}
      >{avatarInitial}</span>
    {:else}
      <span class="eyebrow" style="padding:0">unassigned</span>
    {/if}

    <span class="spacer ml-auto"></span>

    <!-- cost -->
    {#if card.costUsd > 0}
      <span class={card.overBudget ? 'text-coral' : ''} title="Agent cost on this card">
        {fmtUsd(card.costUsd)}
      </span>
    {/if}

    <!-- due -->
    {#if due}
      <span class={overdue ? 'text-coral' : ''} title={overdue ? `Due ${due} — overdue` : `Due ${due}`}>· {due}{overdue ? ' ⚠' : ''}</span>
    {/if}

    <!-- owner avatar -->
    <span
      class="inline-grid size-5 shrink-0 place-items-center rounded-full font-mono text-[9px] font-semibold"
      style="background:var(--inset); color:var(--muted)"
      title={card.ownerUserId}
    >{card.ownerUserId.slice(0, 1).toUpperCase()}</span>
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
      >⚑ Answer {question.agentId}</Button>
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

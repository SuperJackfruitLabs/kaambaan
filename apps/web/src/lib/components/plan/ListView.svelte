<script lang="ts">
  /**
   * The board as rows — for reading rather than scanning.
   *
   * Two things changed beyond the move out of `board/`.
   *
   * **The group-by control came back.** It lived in the topbar, which the 2026-09-03 restructure
   * deleted, leaving `listGroupBy` stuck on `stage` with no way to change it — a control that
   * still worked in the store and had no surface. It belongs here: grouping is a property of this
   * view, not of the app.
   *
   * **Columns sort.** A list you cannot order is a board with the geometry taken away. Sorting is
   * within groups rather than across them, because the grouping is the outer structure and a sort
   * that dissolved it would make the group headers lie.
   */
  import { app } from '$lib/stores/app.svelte';
  import type { Card } from '$lib/api';

  type SortKey = 'title' | 'priority' | 'state' | 'due' | 'cost';

  let sortBy = $state<SortKey>('priority');
  let ascending = $state(false);

  const GROUPS: Array<{ id: typeof app.listGroupBy; label: string }> = [
    { id: 'stage', label: 'stage' },
    { id: 'state', label: 'state' },
    { id: 'owner', label: 'owner' },
    { id: 'priority', label: 'priority' },
  ];

  function agentName(id: string | null | undefined): string {
    return id ? (app.agents.find((a) => a.id === id)?.name ?? id) : '';
  }
  function dueOf(c: Card): string | null {
    return typeof c.spec?.due === 'string' ? c.spec.due : null;
  }
  function isOverdue(c: Card): boolean {
    const d = dueOf(c);
    return d !== null && c.state !== 'completed' && new Date(`${d}T23:59:59`).getTime() < Date.now();
  }

  /** One comparable value per sort key. Missing values sort last however the order is flipped. */
  function valueOf(c: Card, key: SortKey): string | number {
    switch (key) {
      case 'title': return c.title.toLowerCase();
      case 'priority': return c.priority;
      case 'state': return c.state;
      case 'cost': return c.costUsd;
      case 'due': return dueOf(c) ?? '9999-12-31';
    }
  }

  function sorted(cards: Card[]): Card[] {
    return [...cards].sort((a, b) => {
      const x = valueOf(a, sortBy);
      const y = valueOf(b, sortBy);
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return ascending ? cmp : -cmp;
    });
  }

  function sort(key: SortKey): void {
    if (sortBy === key) ascending = !ascending;
    else {
      sortBy = key;
      // Text reads naturally A→Z; numbers and dates are almost always wanted biggest/soonest
      // first, which is why the default flips with the type rather than being one global order.
      ascending = key === 'title' || key === 'state' || key === 'due';
    }
  }

  const groups = $derived.by(() => {
    const board = app.board;
    if (!board) return [] as Array<{ key: string; label: string; cards: Card[] }>;
    const cards = app.filteredCards();
    let out: Array<{ key: string; label: string; cards: Card[] }>;
    if (app.listGroupBy === 'stage') {
      out = board.stages.map((s) => ({ key: s.key, label: s.name, cards: cards.filter((c) => c.currentStageKey === s.key) }));
    } else {
      const keyOf = (c: Card) =>
        app.listGroupBy === 'state' ? c.state : app.listGroupBy === 'owner' ? c.ownerUserId : `P${c.priority}`;
      const keys = [...new Set(cards.map(keyOf))].sort();
      out = keys.map((k) => ({ key: k, label: k, cards: cards.filter((c) => keyOf(c) === k) }));
    }
    return out.filter((g) => g.cards.length > 0).map((g) => ({ ...g, cards: sorted(g.cards) }));
  });

  const arrow = $derived((k: SortKey) => (sortBy === k ? (ascending ? '↑' : '↓') : ''));
</script>

<div class="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
  <span class="eyebrow">group by</span>
  {#each GROUPS as g (g.id)}
    <button
      onclick={() => (app.listGroupBy = g.id)}
      aria-pressed={app.listGroupBy === g.id}
      class="mono rounded-[6px] px-2 text-[11px] {app.listGroupBy === g.id ? 'text-marigold bg-accent-bg' : 'text-muted-foreground hover:text-foreground'}"
      style="min-height:var(--tap)"
    >{g.label}</button>
  {/each}
</div>

{#if groups.length === 0}
  <p class="text-muted-foreground mono py-16 text-center text-sm">No cards match these filters.</p>
{:else}
  <div class="pb-10">
    <!-- Column headers double as the sort control. A separate sort menu would be a second place
         to look for something the columns already name. -->
    <div class="border-border text-muted-foreground mono sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-1.5 text-[10px] tracking-wider uppercase" style="background:var(--ink)">
      <button onclick={() => sort('priority')} class="w-7 shrink-0 text-left uppercase hover:text-[var(--text)]" style="min-height:var(--tap)">pri {arrow('priority')}</button>
      <button onclick={() => sort('title')} class="flex-1 text-left uppercase hover:text-[var(--text)]" style="min-height:var(--tap)">card {arrow('title')}</button>
      <button onclick={() => sort('state')} class="hidden w-20 shrink-0 text-left uppercase hover:text-[var(--text)] md:block" style="min-height:var(--tap)">state {arrow('state')}</button>
      <span class="hidden w-24 shrink-0 sm:block">agent</span>
      <button onclick={() => sort('due')} class="hidden w-24 shrink-0 text-left uppercase hover:text-[var(--text)] sm:block" style="min-height:var(--tap)">due {arrow('due')}</button>
      <button onclick={() => sort('cost')} class="w-14 shrink-0 text-right uppercase hover:text-[var(--text)]" style="min-height:var(--tap)">cost {arrow('cost')}</button>
    </div>

    {#each groups as group (group.key)}
      <div class="mb-4">
        <div class="border-border/60 mb-0.5 flex items-center gap-2 border-b px-4 pt-3 pb-1.5">
          <span class="wordmark text-[13px] tracking-wide">{group.label}</span>
          <span class="mono text-muted-foreground text-xs">{group.cards.length}</span>
        </div>

        {#each group.cards as card (card.id)}
          {@const gate = app.gateForCard(card.id)}
          {@const overdue = isOverdue(card)}
          <button
            onclick={() => app.openCard(card.id)}
            class="border-border/40 hover:bg-inset/60 flex w-full items-center gap-3 border-b px-4 py-2 text-left {gate ? 'tile-gate' : ''}"
          >
            <span class="mono w-7 shrink-0 text-[11px]" style="color:{card.priority === 1 ? 'var(--coral)' : card.priority === 2 ? 'var(--marigold)' : 'var(--muted)'}">
              {card.priority > 0 ? `P${card.priority}` : ''}
            </span>
            <span class="min-w-0 flex-1 truncate text-sm">{card.title}</span>
            {#if card.state === 'working'}<span class="live-dot shrink-0" title="An agent is working this"></span>{/if}
            {#if gate}<span class="eyebrow text-coral shrink-0">review</span>{/if}
            <span class="mono text-muted-foreground hidden w-20 shrink-0 truncate text-[11px] md:block">{card.state}</span>
            <span class="mono text-muted-foreground hidden w-24 shrink-0 truncate text-[11px] sm:block">{agentName(card.delegateAgentId)}</span>
            <span class="mono hidden w-24 shrink-0 truncate text-[11px] sm:block" style="color:{overdue ? 'var(--coral)' : 'var(--muted)'}">
              {dueOf(card) ?? ''}{overdue ? ' ⚠' : ''}
            </span>
            <span class="mono w-14 shrink-0 text-right text-[11px]" style="color:{card.overBudget ? 'var(--coral)' : 'var(--muted)'}">
              {card.costUsd > 0 ? `$${card.costUsd.toFixed(2)}` : ''}
            </span>
          </button>
        {/each}
      </div>
    {/each}
  </div>
{/if}

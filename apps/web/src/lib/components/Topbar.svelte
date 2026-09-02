<script lang="ts">
  import { app, type CardFilters } from '$lib/stores/app.svelte';
  import { markNotificationRead, setBudget } from '$lib/api';
  import { Button } from '$lib/components/ui/button';

  let { onOpenAgents, onNewBoard, onSettings } = $props<{
    onOpenAgents: () => void;
    onNewBoard: () => void;
    onSettings: () => void;
  }>();

  // ---- local UI state ----
  let showBoardMenu = $state(false);
  let showBudget = $state(false);
  let boardCapInput = $state<number | null>(null);
  let cardCapInput = $state<number | null>(null);
  let savingBudget = $state(false);
  let showNotifications = $state(false);
  let showFilterMenu = $state(false);
  let error = $state<string | null>(null);

  // Dispatch form
  let title = $state('');
  // The compose form captured a title and nothing else, though the API has always accepted
  // priority and a spec — so a card could only be created bare and then edited. Collapsed by
  // default, because the one-line dispatch is the common act and should stay one line.
  let composeOpen = $state(false);
  let newPriority = $state(0);
  let newDue = $state('');
  let newDescription = $state('');

  // Filters (local, synced to store via $effect)
  let filters = $state<CardFilters>({
    states: [],
    owners: [],
    minPriority: null,
    needsReview: false,
    live: false,
    overBudget: false,
  });

  // Sync local filters → store
  $effect(() => {
    app.filters = { ...filters };
  });

  const activeFilterCount = $derived(
    filters.states.length +
      filters.owners.length +
      (filters.minPriority !== null ? 1 : 0) +
      (filters.needsReview ? 1 : 0) +
      (filters.live ? 1 : 0) +
      (filters.overBudget ? 1 : 0),
  );

  // ---- helpers ----
  function toggleIn(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  function clearFilters(): void {
    filters = { states: [], owners: [], minPriority: null, needsReview: false, live: false, overBudget: false };
  }

  function fmtUsd(n: number): string {
    return `$${n.toFixed(2)}`;
  }

  // ---- budget ----
  function openBudget(): void {
    boardCapInput = app.board?.usage.budgetUsd ?? null;
    cardCapInput = app.board?.usage.cardUsdCap ?? null;
    showBudget = true;
  }

  async function saveBudget(): Promise<void> {
    if (!app.boardId) return;
    savingBudget = true;
    try {
      const res = await setBudget(app.boardId, {
        boardUsdCap: boardCapInput && boardCapInput > 0 ? boardCapInput : null,
        cardUsdCap: cardCapInput && cardCapInput > 0 ? cardCapInput : null,
      });
      if (!res.ok) error = `Couldn't save the budget (${res.status})`;
      showBudget = false;
      await app.refresh();
    } finally {
      savingBudget = false;
    }
  }

  // ---- notifications ----
  async function onMarkRead(seq: number): Promise<void> {
    if (!app.boardId) return;
    await markNotificationRead(app.boardId, seq);
    await app.refresh();
  }

  // ---- dispatch ----
  async function onAdd(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!app.boardId || title.trim() === '') return;
    try {
      await app.dispatchCard(title.trim(), {
        priority: Number(newPriority) || 0,
        description: newDescription,
        due: newDue,
      });
      title = '';
      newPriority = 0;
      newDue = '';
      newDescription = '';
      composeOpen = false;
    } catch (err) {
      error = String(err);
    }
  }

  // ---- board switch + board delete ----
  async function onDeleteBoard(id: string): Promise<void> {
    showBoardMenu = false;
    await app.deleteBoard(id);
    if (app.error) error = app.error;
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      showBoardMenu = false;
      showBudget = false;
      showNotifications = false;
      showFilterMenu = false;
    }
  }}
/>

<header class="border-border bg-surface/80 flex flex-col border-b backdrop-blur-sm">
  <!-- Main topbar row -->
  <div class="flex items-center gap-3 px-4 py-2.5">
    <!--
      The way back to navigation on a phone. `md:hidden` because above that
      the rail is always on screen and a button to reveal it would do nothing.
    -->
    <button
      onclick={() => app.toggleRail()}
      class="text-muted-foreground hover:text-foreground -ml-1 shrink-0 md:hidden"
      aria-label="Navigation"
      aria-expanded={app.railOpen}
    >
      <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
    <!-- Board name / switcher -->
    <div class="relative flex-1 min-w-0">
      <button
        onclick={() => (showBoardMenu = !showBoardMenu)}
        class="mono inline-flex max-w-full items-center gap-1 truncate text-sm font-medium hover:opacity-80"
      >
        <span class="truncate">{app.board?.name ?? 'Board'}</span>
        <svg class="size-3.5 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {#if showBoardMenu}
        <div class="bg-card border-border absolute left-0 z-30 mt-2 w-72 rounded-[10px] border p-1.5 shadow-2xl">
          <div class="eyebrow px-1.5 py-1">boards</div>
          {#each app.boards as b (b.id)}
            <div class="group hover:bg-muted flex items-center rounded-[7px]">
              <button
                onclick={() => { showBoardMenu = false; void app.switchBoard(b.id); }}
                class="flex flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs"
              >
                <span class="size-1.5 shrink-0 rounded-full" style="background:{b.id === app.boardId ? 'var(--marigold)' : 'var(--muted)'}"></span>
                <span class="truncate {b.id === app.boardId ? 'text-foreground' : 'text-muted-foreground'}">{b.name}</span>
              </button>
              <button
                onclick={() => void onDeleteBoard(b.id)}
                aria-label="Delete board"
                title="Delete board"
                class="text-muted-foreground hover:text-coral mr-1 px-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
          {/each}
          <button
            onclick={() => { showBoardMenu = false; onSettings(); }}
            class="text-muted-foreground hover:text-foreground hover:bg-muted border-border/60 mt-1 flex w-full items-center gap-1.5 rounded-[7px] border-t px-2 py-1.5 text-left text-xs"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>
            Board settings
          </button>
          <button
            onclick={() => { showBoardMenu = false; onNewBoard(); }}
            class="text-marigold hover:bg-muted mt-0.5 flex w-full items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-left text-xs"
          >
            <span class="text-sm leading-none">+</span> New board
          </button>
        </div>
      {/if}
    </div>

    <!-- Dispatch form -->
    <form class="relative flex items-center gap-1.5" onsubmit={onAdd}>
      <input
        bind:value={title}
        data-testid="dispatch-title"
        placeholder="Dispatch a card…"
        aria-label="New card title"
        class="bg-inset border-border focus:border-marigold mono w-44 rounded-[7px] border px-2.5 py-1.5 text-xs outline-none"
      />
      <button
        type="button"
        onclick={() => (composeOpen = !composeOpen)}
        aria-expanded={composeOpen}
        aria-label="More card details"
        title="Priority, due date and description"
        class="text-muted-foreground hover:text-foreground mono shrink-0 px-1 text-xs"
      >{composeOpen ? '–' : '+'}</button>
      <Button type="submit" size="sm">Dispatch</Button>

      {#if composeOpen}
        <div class="bg-surface border-border absolute top-full right-0 z-30 mt-1.5 w-72 rounded-[9px] border p-3 shadow-xl">
          <div class="flex items-center gap-3">
            <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">
              priority
              <input type="number" bind:value={newPriority} class="bg-inset border-border focus:border-marigold w-14 rounded-[5px] border px-1.5 py-1 outline-none" />
            </label>
            <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">
              due
              <input type="date" bind:value={newDue} aria-label="Due date" class="bg-inset border-border focus:border-marigold rounded-[5px] border px-1.5 py-1 outline-none" />
            </label>
          </div>
          <textarea
            bind:value={newDescription}
            rows="3"
            aria-label="Description"
            placeholder="Brief for the agent…"
            class="bg-inset border-border focus:border-marigold mt-2 w-full resize-none rounded-[6px] border px-2.5 py-2 text-xs outline-none"
          ></textarea>
        </div>
      {/if}
    </form>

    <!-- View toggle -->
    <div class="border-border inline-flex overflow-hidden rounded-[7px] border text-xs">
      <button
        onclick={() => app.setView('board')}
        class="mono px-2.5 py-1.5 {app.view === 'board' ? 'bg-marigold text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
      >Board</button>
      <button
        onclick={() => app.setView('list')}
        class="mono border-border border-l px-2.5 py-1.5 {app.view === 'list' ? 'bg-marigold text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
      >List</button>
    </div>

    <!-- Filter button -->
    <div class="relative">
      <button
        onclick={() => (showFilterMenu = !showFilterMenu)}
        class="border-border hover:border-marigold/50 mono inline-flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1.5 text-xs"
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
        Filter{#if activeFilterCount > 0}<span style="color:var(--marigold)"> · {activeFilterCount}</span>{/if}
      </button>
      {#if showFilterMenu}
        <div class="bg-card border-border absolute right-0 z-30 mt-2 w-64 rounded-[10px] border p-2 shadow-2xl max-sm:fixed max-sm:inset-x-4 max-sm:top-16 max-sm:mt-0 max-sm:w-auto">
          {#if app.boardStates().length > 0}
            <div class="eyebrow px-1.5 py-1">state</div>
            {#each app.boardStates() as s (s)}
              <button onclick={() => (filters.states = toggleIn(filters.states, s))} class="hover:bg-muted flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-xs">
                <span class="size-3 rounded-[3px] border {filters.states.includes(s) ? 'border-marigold bg-marigold' : 'border-border'}"></span>{s}
              </button>
            {/each}
          {/if}
          {#if app.boardOwners().length > 0}
            <div class="eyebrow mt-1.5 px-1.5 py-1">owner</div>
            {#each app.boardOwners() as o (o)}
              <button onclick={() => (filters.owners = toggleIn(filters.owners, o))} class="hover:bg-muted flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-xs">
                <span class="size-3 rounded-[3px] border {filters.owners.includes(o) ? 'border-marigold bg-marigold' : 'border-border'}"></span><span class="truncate">{o}</span>
              </button>
            {/each}
          {/if}
          <label class="text-muted-foreground mt-2 flex items-center justify-between gap-2 px-1.5 text-xs">
            min priority
            <input type="number" min="0" bind:value={filters.minPriority} placeholder="any" class="bg-inset border-border focus:border-marigold mono w-16 rounded-[5px] border px-1.5 py-0.5 text-[11px] outline-none" />
          </label>
          <div class="border-border mt-2 space-y-0.5 border-t pt-1.5">
            <button onclick={() => (filters.needsReview = !filters.needsReview)} class="hover:bg-muted flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-xs"><span class="size-3 rounded-[3px] border {filters.needsReview ? 'border-coral bg-coral' : 'border-border'}"></span>needs review</button>
            <button onclick={() => (filters.live = !filters.live)} class="hover:bg-muted flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-xs"><span class="size-3 rounded-[3px] border {filters.live ? 'border-marigold bg-marigold' : 'border-border'}"></span>live (working)</button>
            <button onclick={() => (filters.overBudget = !filters.overBudget)} class="hover:bg-muted flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-xs"><span class="size-3 rounded-[3px] border {filters.overBudget ? 'border-coral bg-coral' : 'border-border'}"></span>over budget</button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Live/offline indicator -->
    <span class="border-border mono inline-flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1.5 text-xs">
      {#if app.connected}
        <span class="live-dot"></span><span style="color:var(--live)">live</span>
      {:else}
        <span style="color:var(--muted)">○</span><span style="color:var(--muted)">offline</span>
      {/if}
    </span>

    <!-- Spend meter -->
    {#if app.board}
      <div class="relative">
        <button
          onclick={openBudget}
          title="Set budget caps"
          class="border-border hover:border-marigold/50 flex items-center gap-2 rounded-[7px] border px-2.5 py-1.5"
        >
          <span class="eyebrow">spend</span>
          <span class="mono text-xs {app.board.usage.overBudget ? 'text-coral' : ''}">
            {fmtUsd(app.board.usage.totalCostUsd)}{#if app.board.usage.budgetUsd !== null}<span class="text-muted-foreground">/{fmtUsd(app.board.usage.budgetUsd)}</span>{/if}
          </span>
          {#if app.board.usage.budgetUsd !== null}
            <span class="bg-muted relative h-1 w-14 overflow-hidden rounded-full">
              <span
                class="absolute inset-y-0 left-0 rounded-full"
                style="width:{Math.min(100, (app.board.usage.totalCostUsd / app.board.usage.budgetUsd) * 100)}%; background:{app.board.usage.overBudget ? 'var(--coral)' : 'var(--marigold)'}"
              ></span>
            </span>
          {/if}
        </button>
        {#if showBudget}
          <div class="bg-card border-border absolute right-0 z-30 mt-2 w-64 rounded-[10px] border p-3 shadow-2xl max-sm:fixed max-sm:inset-x-4 max-sm:top-16 max-sm:mt-0 max-sm:w-auto">
            <div class="eyebrow mb-2">budget caps (USD)</div>
            <label class="mb-2 block">
              <span class="text-muted-foreground text-xs">whole board</span>
              <input type="number" min="0" step="0.5" bind:value={boardCapInput} placeholder="no cap" class="bg-inset border-border focus:border-marigold mono mt-1 w-full rounded-[6px] border px-2 py-1.5 text-xs outline-none" />
            </label>
            <label class="block">
              <span class="text-muted-foreground text-xs">per card</span>
              <input type="number" min="0" step="0.5" bind:value={cardCapInput} placeholder="no cap" class="bg-inset border-border focus:border-marigold mono mt-1 w-full rounded-[6px] border px-2 py-1.5 text-xs outline-none" />
            </label>
            <p class="text-muted-foreground mt-2 text-[11px] leading-relaxed">When spend hits a cap, agents stop being handed new work.</p>
            <div class="mt-3 flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onclick={() => (showBudget = false)}>Cancel</Button>
              <Button size="sm" onclick={saveBudget} disabled={savingBudget}>{savingBudget ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Notifications -->
    <div class="relative">
      <button
        onclick={() => (showNotifications = !showNotifications)}
        aria-label="Notifications"
        class="border-border inline-flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1.5"
      >
        <svg class="size-3.5 {app.unreadCount() > 0 ? 'text-coral' : 'text-muted-foreground'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        <span class="mono text-xs {app.unreadCount() > 0 ? 'text-coral' : 'text-muted-foreground'}">{app.unreadCount()}</span>
      </button>
      {#if showNotifications}
        <div class="bg-card border-border absolute right-0 z-30 mt-2 w-80 rounded-[10px] border p-1.5 shadow-2xl max-sm:fixed max-sm:inset-x-4 max-sm:top-16 max-sm:mt-0 max-sm:w-auto">
          <div class="eyebrow px-1.5 py-1">alerts</div>
          {#if app.notifications.length === 0}
            <p class="text-muted-foreground px-1.5 py-2 text-sm">All clear — nothing needs you.</p>
          {:else}
            {#each app.notifications.slice(0, 20) as n (n.seq)}
              <button
                onclick={() => void onMarkRead(n.seq)}
                class="hover:bg-muted flex w-full items-start gap-2.5 rounded-[7px] p-2 text-left text-xs"
              >
                <span class="mt-1.5 size-1.5 shrink-0 rounded-full" style="background:{n.read ? 'var(--muted)' : 'var(--coral)'}"></span>
                <span>
                  <span class="mono uppercase tracking-wide" style="color:{n.read ? 'var(--muted)' : 'var(--text)'}">{n.kind}</span>
                  <span class="text-muted-foreground"> — {n.body}</span>
                </span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Agents button -->
    <Button size="sm" variant="outline" onclick={onOpenAgents}>Agents</Button>

    <!-- Search / CmdK -->
    <button
      onclick={() => app.toggleCmdk()}
      aria-label="Search"
      class="border-border text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1.5 text-xs"
    >
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
      </svg>
      <span class="mono hidden sm:inline text-[11px]">⌘K</span>
    </button>
  </div>

  <!-- Filter chips row (only when filters are active) -->
  {#if activeFilterCount > 0 || app.view === 'list'}
    <div class="flex flex-wrap items-center gap-2 border-border border-t px-4 py-1.5">
      {#each filters.states as s (s)}
        <button onclick={() => (filters.states = toggleIn(filters.states, s))} class="bg-inset border-border mono rounded-[6px] border px-2 py-0.5 text-[11px]">state: {s} ×</button>
      {/each}
      {#each filters.owners as o (o)}
        <button onclick={() => (filters.owners = toggleIn(filters.owners, o))} class="bg-inset border-border mono rounded-[6px] border px-2 py-0.5 text-[11px]">owner: {o} ×</button>
      {/each}
      {#if filters.minPriority !== null}
        <button onclick={() => (filters.minPriority = null)} class="bg-inset border-border mono rounded-[6px] border px-2 py-0.5 text-[11px]">≥ P{filters.minPriority} ×</button>
      {/if}
      {#if filters.needsReview}
        <button onclick={() => (filters.needsReview = false)} class="bg-inset border-coral/50 text-coral mono rounded-[6px] border px-2 py-0.5 text-[11px]">needs review ×</button>
      {/if}
      {#if filters.live}
        <button onclick={() => (filters.live = false)} class="bg-inset border-border mono rounded-[6px] border px-2 py-0.5 text-[11px]">live ×</button>
      {/if}
      {#if filters.overBudget}
        <button onclick={() => (filters.overBudget = false)} class="bg-inset border-coral/50 text-coral mono rounded-[6px] border px-2 py-0.5 text-[11px]">over budget ×</button>
      {/if}
      {#if activeFilterCount > 0}
        <button onclick={clearFilters} class="text-muted-foreground hover:text-foreground text-xs">clear</button>
      {/if}

      {#if app.view === 'list'}
        <div class="text-muted-foreground ml-auto flex items-center gap-1.5">
          <span class="eyebrow">group</span>
          {#each ['stage', 'state', 'owner', 'priority'] as g (g)}
            <button
              onclick={() => (app.listGroupBy = g as typeof app.listGroupBy)}
              class="mono rounded-[5px] px-1.5 py-0.5 text-[11px] {app.listGroupBy === g ? 'text-marigold' : 'text-muted-foreground hover:text-foreground'}"
            >{g}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Error bar -->
  {#if error || app.error}
    <div role="alert" class="border-coral/40 text-coral mono border-t px-4 py-1.5 text-xs" style="background:rgba(255,107,87,.08)">
      {error ?? app.error}
    </div>
  {/if}
</header>

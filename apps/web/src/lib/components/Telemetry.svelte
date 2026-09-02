<script lang="ts">
  import { getUsage, getBoardEvents, type UsageSummary, type BoardEvent } from '$lib/api';
  import { app } from '$lib/stores/app.svelte';
  import { agentColor, initialOf } from '$lib/components/agentColor';

  // ---- reactive data ----
  let usage = $state<UsageSummary | null>(null);
  let loading = $state(false);
  // Distinct from `usage === null`: a failed fetch used to arrive as a zeroed summary, so a
  // broken telemetry API read exactly like a board that had spent nothing.
  let usageError = $state<string | null>(null);
  let events = $state<BoardEvent[]>([]);
  let eventsError = $state<string | null>(null);
  let window_ = $state<'5h' | '7d'>('7d');

  // ---- derived from store ----
  const board = $derived(app.board);
  const agents = $derived(app.agents);
  const boardId = $derived(app.boardId);

  // budget metrics from board snapshot
  const totalCost = $derived(board?.usage.totalCostUsd ?? 0);
  const budgetUsd = $derived(board?.usage.budgetUsd ?? null);
  const overBudget = $derived(board?.usage.overBudget ?? false);
  const burnPct = $derived(
    budgetUsd && budgetUsd > 0 ? Math.min(100, Math.round((totalCost / budgetUsd) * 100)) : 0,
  );

  // token totals from usage report
  const totalInput = $derived(usage?.totalInputTokens ?? 0);
  const totalOutput = $derived(usage?.totalOutputTokens ?? 0);
  const totalTokens = $derived(totalInput + totalOutput);

  // avg cost per card — derived from usage window (consistent data window)
  const avgCostPerCard = $derived(
    usage && usage.byCard.length > 0
      ? usage.totalCostUsd / Math.max(1, usage.byCard.length)
      : null,
  );

  // helper: agent name from id
  function agentName(id: string): string {
    return agents.find((a) => a.id === id)?.name ?? id;
  }

  // helper: card title from id
  function cardTitle(id: string): string {
    return board?.cards.find((c) => c.id === id)?.title ?? id;
  }

  // helper: format USD
  function usd(n: number): string {
    return '$' + n.toFixed(2);
  }

  // helper: format token count
  function fmtK(n: number): string {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  // max cost for bar scaling
  const maxAgentCost = $derived(
    usage?.byAgent.length ? Math.max(...usage.byAgent.map((a) => a.costUsd), 0.001) : 0.001,
  );
  const maxModelCost = $derived(
    usage?.byModel.length ? Math.max(...usage.byModel.map((m) => m.costUsd), 0.001) : 0.001,
  );
  const maxCardCost = $derived(
    usage?.byCard.length ? Math.max(...usage.byCard.map((c) => c.costUsd), 0.001) : 0.001,
  );

  // ---- fetch ----
  async function load(id: string, win: '5h' | '7d') {
    loading = true;
    usageError = null;
    try {
      usage = await getUsage(id, win);
    } catch (e) {
      usage = null;
      usageError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
    eventsError = null;
    try {
      events = await getBoardEvents(id, 60);
    } catch (e) {
      events = [];
      eventsError = e instanceof Error ? e.message : String(e);
    }
  }

  function eventSummary(e: BoardEvent): string {
    const p = e.payload as Record<string, unknown>;
    const bits = ['cardId', 'agentId', 'to', 'from', 'name', 'reason', 'decision']
      .filter((k) => typeof p[k] === 'string')
      .map((k) => `${k}=${p[k] as string}`);
    return bits.join(' · ');
  }

  function timeOf(iso: string): string {
    return iso.slice(11, 19);
  }

  // re-fetch whenever boardId or window changes (covers first render too)
  $effect(() => {
    if (boardId) load(boardId, window_);
  });
</script>

<div class="tele-pad scroll flex-1 overflow-y-auto">
  <!-- header row -->
  <div class="mb-4 flex items-end justify-between gap-4 flex-wrap">
    <div>
      <div class="eyebrow mb-1">telemetry</div>
      <h1 class="wordmark text-xl">Agent telemetry</h1>
      <p class="text-muted-foreground mt-1 text-sm">
        {board?.name ?? 'Board'} · last
        <button
          class="mono text-xs underline underline-offset-2 hover:text-foreground transition"
          onclick={() => { window_ = window_ === '7d' ? '5h' : '7d'; }}
        >
          {window_ === '7d' ? '7 days' : '5 hours'}
        </button>
        {#if loading}<span class="mono text-muted-foreground text-xs ml-2">loading…</span>{/if}
        {#if usageError}<span class="mono text-coral text-xs ml-2">couldn't load usage — {usageError}</span>{/if}
      </p>
    </div>
  </div>

  <!-- ===== metric cards ===== -->
  <div class="tele-grid">
    <!-- Spend / budget -->
    <div class="tele-metric">
      <div class="tele-metric-k">Spend / budget</div>
      <div class="tele-metric-v" style={overBudget ? 'color:var(--coral)' : ''}>
        {usd(totalCost)}
        {#if budgetUsd}<small class="text-muted-foreground font-medium text-sm">/ {usd(budgetUsd)}</small>{/if}
      </div>
      {#if budgetUsd}
        <div class="tele-burn" class:tele-burn-over={overBudget}>
          <i style="width:{burnPct}%"></i>
        </div>
        <div
          class="mono mt-1 text-[10px]"
          style={overBudget ? 'color:var(--coral)' : 'color:var(--muted-foreground)'}
        >
          {burnPct}% of budget used{overBudget ? ' · over budget' : ''}
        </div>
      {:else}
        <div class="mono text-muted-foreground mt-1 text-[10px]">no budget cap set</div>
      {/if}
    </div>

    <!-- Avg cost / card -->
    <div class="tele-metric">
      <div class="tele-metric-k">Avg cost / card</div>
      <div class="tele-metric-v">{avgCostPerCard !== null ? usd(avgCostPerCard) : '—'}</div>
      <div class="mono text-muted-foreground mt-1 text-[10px]">
        {usage?.byCard.length ?? 0} cards with spend in window
      </div>
    </div>

    <!-- Total tokens -->
    <div class="tele-metric">
      <div class="tele-metric-k">Total tokens</div>
      <div class="tele-metric-v">{fmtK(totalTokens)}</div>
      <div class="mono text-muted-foreground mt-1 text-[10px]">
        in {fmtK(totalInput)} · out {fmtK(totalOutput)}
      </div>
    </div>

    <!-- Unpriced records -->
    <div class="tele-metric">
      <div class="tele-metric-k">Unpriced records</div>
      <div class="tele-metric-v">{usage?.unpricedRecords ?? 0}</div>
      <div class="mono text-muted-foreground mt-1 text-[10px]">records without cost data</div>
    </div>
  </div>

  <!-- ===== two-column panels ===== -->
  <div class="tele-two">
    <!-- By agent -->
    <div class="tele-panel">
      <div class="tele-panel-h">By agent</div>
      {#if usage?.byAgent.length}
        <div class="tele-bars">
          {#each usage.byAgent as row (row.agentId)}
            {@const name = agentName(row.agentId)}
            {@const color = agentColor(row.agentId)}
            {@const pct = Math.round((row.costUsd / maxAgentCost) * 100)}
            <div class="tele-barrow">
              <span class="flex items-center gap-1.5 truncate">
                <span
                  class="tele-av flex-none"
                  style="background:{color};color:#0f1118"
                  title={name}
                >{initialOf(name)}</span>
                <span class="truncate text-xs">{name}</span>
              </span>
              <span class="tele-track"><i style="width:{pct}%;background:{color}"></i></span>
              <span class="tele-num">{usd(row.costUsd)}</span>
            </div>
          {/each}
        </div>
      {:else}
        <p class="tele-empty">No agent cost data yet.</p>
      {/if}
    </div>

    <!-- By model -->
    <div class="tele-panel">
      <div class="tele-panel-h">By model</div>
      {#if usage?.byModel.length}
        <div class="tele-bars">
          {#each usage.byModel as row (row.model)}
            {@const pct = Math.round((row.costUsd / maxModelCost) * 100)}
            <div class="tele-barrow">
              <span class="mono truncate text-xs">{row.model}</span>
              <span class="tele-track"><i style="width:{pct}%"></i></span>
              <span class="tele-num">{usd(row.costUsd)}</span>
            </div>
          {/each}
        </div>
      {:else}
        <p class="tele-empty">No model cost data yet.</p>
      {/if}
    </div>
  </div>

  <!-- By card (full width) -->
  <div class="tele-panel mt-3">
    <div class="tele-panel-h">Top spenders · by card</div>
    {#if usage?.byCard.length}
      <div class="tele-bars">
        {#each usage.byCard.slice(0, 8) as row (row.cardId)}
          {@const title = cardTitle(row.cardId)}
          {@const pct = Math.round((row.costUsd / maxCardCost) * 100)}
          <div class="tele-barrow tele-barrow-wide">
            <span class="truncate text-xs">{title}</span>
            <span class="tele-track"><i style="width:{pct}%"></i></span>
            <span class="tele-num">{usd(row.costUsd)}</span>
          </div>
        {/each}
      </div>
    {:else}
      <p class="tele-empty">No card cost data yet.</p>
    {/if}
  </div>

  <!--
    The board log.

    `BoardDO.getEvents` had no route and no caller: every state change was appended to `events`
    and there was no way to read them back, so the only audit trail the product keeps was
    unreachable — which is the same as not keeping one.
  -->
  <div class="tele-panel mt-5">
    <div class="eyebrow mb-2">board log</div>
    {#if eventsError}
      <p class="tele-empty">Couldn't load the board log — {eventsError}</p>
    {:else if events.length === 0}
      <p class="tele-empty">Nothing has happened on this board yet.</p>
    {:else}
      <div class="space-y-1">
        {#each [...events].reverse() as e (e.seq)}
          <div class="mono flex items-baseline gap-2 text-[11px]">
            <span class="text-muted-foreground shrink-0">{timeOf(e.ts)}</span>
            <span class="shrink-0">{e.type}</span>
            <span class="text-muted-foreground truncate">{eventSummary(e)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Tier 2 note -->
  <p class="eyebrow mt-5 leading-relaxed">
    success rate · time-in-stage · throughput · gate-rejection — coming with the telemetry aggregation (Tier 2)
  </p>
</div>

<script lang="ts">
  /**
   * Spend, and the caps that bound it.
   *
   * The topbar used to show `SPEND $0.00` on a board with no budget and no runs — zero rendered as
   * a fact when it was an absence. Here the figure sits next to the cap it is a fraction of, and
   * the cap controls live beside the figure they cap rather than behind a dialog somewhere else.
   */
  import { app } from '$lib/stores/app.svelte';
  import { setBudget, getUsage, type UsageSummary } from '$lib/api';

  let usage = $state<UsageSummary | null>(null);
  let usageError = $state<string | null>(null);
  let editing = $state(false);
  let boardCap = $state('');
  let cardCap = $state('');
  let saving = $state(false);

  const board = $derived(app.board);
  const total = $derived(board?.usage.totalCostUsd ?? 0);
  const cap = $derived(board?.usage.budgetUsd ?? null);
  const pct = $derived(cap && cap > 0 ? Math.min(100, Math.round((total / cap) * 100)) : null);
  const maxAgent = $derived(usage?.byAgent.length ? Math.max(...usage.byAgent.map((a) => a.costUsd), 0.001) : 0.001);

  $effect(() => {
    const id = app.boardId;
    if (!id) return;
    usageError = null;
    void getUsage(id, '7d')
      .then((u) => (usage = u))
      .catch((e) => { usage = null; usageError = e instanceof Error ? e.message : String(e); });
  });

  function startEdit(): void {
    editing = true;
    boardCap = board?.usage.budgetUsd?.toString() ?? '';
    cardCap = board?.usage.cardUsdCap?.toString() ?? '';
  }

  async function save(): Promise<void> {
    if (!app.boardId) return;
    saving = true;
    try {
      await setBudget(app.boardId, {
        boardUsdCap: boardCap.trim() === '' ? null : Number(boardCap),
        cardUsdCap: cardCap.trim() === '' ? null : Number(cardCap),
      });
      await app.refresh();
      editing = false;
    } finally {
      saving = false;
    }
  }

  const usd = (n: number) => `$${n.toFixed(2)}`;
</script>

<section class="border-border bg-surface overflow-hidden rounded-[12px] border">
  <div class="border-border flex items-center gap-2 border-b px-3.5 py-2.5">
    <h2 class="text-sm font-semibold">Spend</h2>
    <span class="mono text-muted-foreground text-[11px]">last 7 days</span>
    <a href="/b/{app.boardId}/operate/telemetry" class="mono text-muted-foreground hover:text-foreground ml-auto text-[11px] underline underline-offset-2">detail</a>
  </div>

  <div class="px-3.5 py-3">
    {#if usageError}
      <p class="text-coral text-xs leading-relaxed">Couldn't load usage — {usageError}</p>
    {:else}
      <div class="flex items-baseline gap-2">
        <span class="mono text-2xl" style="color:{board?.usage.overBudget ? 'var(--coral)' : 'var(--text)'}">{usd(total)}</span>
        {#if cap !== null}
          <span class="mono text-muted-foreground text-[11px]">of {usd(cap)} cap</span>
        {:else}
          <span class="mono text-muted-foreground text-[11px]">no cap set</span>
        {/if}
      </div>

      {#if pct !== null}
        <div class="bg-inset mt-2 h-[5px] overflow-hidden rounded-full">
          <div class="h-full" style="width:{pct}%;background:{board?.usage.overBudget ? 'var(--coral)' : 'var(--marigold)'}"></div>
        </div>
      {/if}

      {#if usage && usage.byAgent.length > 0}
        <div class="mt-3 grid gap-1.5">
          {#each usage.byAgent.slice(0, 5) as row (row.agentId)}
            <div class="mono grid grid-cols-[7rem_1fr_3.4rem] items-center gap-2 text-[11px]">
              <span class="truncate">{app.agents.find((a) => a.id === row.agentId)?.name ?? row.agentId}</span>
              <span class="bg-inset h-[4px] overflow-hidden rounded-full"><i class="bg-marigold block h-full" style="width:{Math.round((row.costUsd / maxAgent) * 100)}%"></i></span>
              <span class="text-muted-foreground text-right">{usd(row.costUsd)}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    <div class="border-border mt-3 border-t pt-2.5">
      {#if editing}
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">board cap $
            <input bind:value={boardCap} placeholder="none" class="bg-inset border-border focus:border-marigold w-20 rounded-[5px] border px-1.5 py-1" /></label>
          <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">card cap $
            <input bind:value={cardCap} placeholder="none" class="bg-inset border-border focus:border-marigold w-20 rounded-[5px] border px-1.5 py-1" /></label>
          <button onclick={() => void save()} disabled={saving} class="mono text-[11px]" style="color:var(--marigold);min-height:var(--tap)">{saving ? 'saving…' : 'save'}</button>
          <button onclick={() => (editing = false)} class="text-muted-foreground mono text-[11px]" style="min-height:var(--tap)">cancel</button>
        </div>
      {:else}
        <button onclick={startEdit} class="text-muted-foreground hover:text-foreground mono text-[11px] underline underline-offset-2" style="min-height:var(--tap)">
          {cap === null ? 'Set a budget cap' : 'Change the caps'}
        </button>
      {/if}
    </div>
  </div>
</section>

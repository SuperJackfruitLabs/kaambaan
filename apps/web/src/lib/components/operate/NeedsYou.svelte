<script lang="ts">
  /**
   * Attention as an object, not a bell.
   *
   * The old surface was a badge showing a number — including `0`, which says "there is nothing" in
   * the visual language of "there is something" — plus a separate Triage screen listing cards. The
   * action always lived somewhere else.
   *
   * Here each row carries its own resolution. Six sources, all reads of state that already exists:
   * a pending gate, an agent's question, a card refused at claim under the control pair, a failed
   * card, and a card over budget. (Dead-lettered deliveries are the sixth and are surfaced through
   * the board's own notifications rather than a separate fetch.)
   */
  import { app } from '$lib/stores/app.svelte';
  import { resolveGate, type GateDecision } from '$lib/api';

  type Item = {
    id: string;
    kind: 'gate' | 'asked' | 'refused' | 'failed' | 'budget';
    title: string;
    detail: string;
    cardId: string;
  };

  const items = $derived.by((): Item[] => {
    const out: Item[] = [];
    for (const c of app.board?.cards ?? []) {
      const gate = app.gateForCard(c.id);
      const ask = app.elicitationForCard(c.id);
      if (gate) out.push({ id: `g:${gate.id}`, kind: 'gate', title: c.title, detail: `${gate.stageKey} · waiting on you`, cardId: c.id });
      else if (ask) out.push({ id: `e:${ask.id}`, kind: 'asked', title: c.title, detail: `${ask.agentId} asked a question`, cardId: c.id });
      else if (c.state === 'failed') out.push({ id: `f:${c.id}`, kind: 'failed', title: c.title, detail: 'the run failed', cardId: c.id });
      else if (c.state === 'input-required')
        // The control-pair refusal: the card was queued without authority, or the agent that could
        // claim it holds a capability no stage names. Both park the card here and say why.
        out.push({ id: `r:${c.id}`, kind: 'refused', title: c.title, detail: 'not dispatched — nobody with permission asked for it, or no agent can claim it', cardId: c.id });
      else if (c.overBudget) out.push({ id: `b:${c.id}`, kind: 'budget', title: c.title, detail: 'over its budget cap', cardId: c.id });
    }
    return out;
  });

  const LABEL: Record<Item['kind'], string> = { gate: 'gate', asked: 'asked', refused: 'refused', failed: 'failed', budget: 'budget' };

  async function decide(cardId: string, decision: GateDecision): Promise<void> {
    const gate = app.gateForCard(cardId);
    if (!app.boardId || !gate) return;
    const res = await resolveGate(app.boardId, gate.id, decision);
    if (res.ok) await app.refresh();
  }
</script>

<section class="border-border bg-surface overflow-hidden rounded-[12px] border">
  <div class="border-border flex items-center gap-2 border-b px-3.5 py-2.5">
    <h2 class="text-sm font-semibold">Needs you</h2>
    <span class="mono text-[11px]" style="color:{items.length > 0 ? 'var(--coral)' : 'var(--muted)'}">{items.length}</span>
  </div>

  {#if items.length === 0}
    <p class="text-muted-foreground px-3.5 py-4 text-sm">Nothing is waiting on you.</p>
  {:else}
    {#each items as it (it.id)}
      <div class="border-border flex flex-wrap items-center gap-2.5 border-b px-3.5 py-2.5 last:border-b-0">
        <span
          class="mono shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px] tracking-wider uppercase"
          style="color:{it.kind === 'gate' || it.kind === 'failed' ? 'var(--coral)' : it.kind === 'asked' ? 'var(--marigold)' : 'var(--muted)'};
                 background:var(--inset)"
        >{LABEL[it.kind]}</span>

        <button onclick={() => app.openCard(it.cardId)} class="min-w-[9rem] flex-1 text-left">
          <span class="block text-[13px] leading-snug">{it.title}</span>
          <span class="mono text-muted-foreground block text-[11px] leading-snug">{it.detail}</span>
        </button>

        {#if it.kind === 'gate'}
          <button onclick={() => void decide(it.cardId, 'approve')} class="bg-primary text-primary-foreground rounded-[7px] px-2.5 text-xs font-semibold" style="min-height:var(--tap)">Approve</button>
          <button onclick={() => app.openCard(it.cardId)} class="border-border hover:border-marigold rounded-[7px] border px-2.5 text-xs" style="min-height:var(--tap)">Changes</button>
        {:else if it.kind === 'asked'}
          <button onclick={() => app.openCard(it.cardId)} class="bg-primary text-primary-foreground rounded-[7px] px-2.5 text-xs font-semibold" style="min-height:var(--tap)">Answer</button>
        {:else if it.kind === 'refused'}
          <a href="/workspace/capabilities" class="border-border hover:border-marigold inline-flex items-center rounded-[7px] border px-2.5 text-xs" style="min-height:var(--tap)">Staff an agent</a>
        {:else}
          <button onclick={() => app.openCard(it.cardId)} class="border-border hover:border-marigold rounded-[7px] border px-2.5 text-xs" style="min-height:var(--tap)">Open</button>
        {/if}
      </div>
    {/each}
  {/if}
</section>

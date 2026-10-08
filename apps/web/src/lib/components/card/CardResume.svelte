<script lang="ts">
  /**
   * Resume, on the card: why it stopped (the card's own words), an optional earlier stage, and the
   * comment the next agent will read. Shown only when resume is the right answer — an open question
   * and a pending review have their own panels and the server refuses resume for both.
   */
  import { resumeCard, type Card, type Stage } from '$lib/api';
  import { refusalOf } from '$lib/components/attention/refusal';
  import ResumeBox from '$lib/components/attention/ResumeBox.svelte';

  let {
    boardId,
    card,
    stages,
    gatePending,
    questionPending,
    onResumed,
  }: {
    boardId: string;
    card: Card;
    stages: Stage[];
    gatePending: boolean;
    questionPending: boolean;
    onResumed: () => void | Promise<void>;
  } = $props();

  const show = $derived(card.state === 'input-required' && !gatePending && !questionPending && card.openChildCount === 0);
  /** This stage, then each earlier one, nearest first. */
  const targets = $derived.by(() => {
    const idx = stages.findIndex((s) => s.key === card.currentStageKey);
    return idx === -1 ? [] : stages.slice(0, idx + 1).reverse();
  });
  let target = $state('');
  const HEADING: Record<string, string> = {
    blocked: 'stopped — waiting on you',
    'repeated-failure': 'failed repeatedly — the board stopped retrying',
    'not-authorised': 'not dispatched — nobody with permission asked for it',
    question: 'stopped — waiting on you',
    review: 'stopped — waiting on you',
  };
  const heading = $derived(HEADING[card.needsHuman?.reason ?? 'blocked'] ?? HEADING.blocked);

  async function submit(comment: string): Promise<string | null> {
    const to = target && target !== card.currentStageKey ? target : undefined;
    const refused = await refusalOf(await resumeCard(boardId, card.id, comment, to));
    if (!refused) await onResumed();
    return refused;
  }
</script>

{#if show}
  <section class="sec">
    <div class="border rounded-[10px] p-3.5" style="border-color:rgba(255,107,87,.35);background:rgba(255,107,87,.06)">
      <div class="eyebrow mb-1.5" style="color:var(--coral)">{heading}</div>
      {#if card.needsHuman?.failureCount}
        <p class="mono text-muted-foreground mb-1 text-[11px]">{card.needsHuman.failureCount} failed attempts</p>
      {/if}
      {#if card.needsHuman?.detail}
        <p class="mb-3 text-[13px] leading-relaxed break-words whitespace-pre-wrap">{card.needsHuman.detail}</p>
      {/if}
      {#if targets.length > 1}
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <label for="resume-at-{card.id}" class="text-muted-foreground text-[11px]">Resume at</label>
          <select id="resume-at-{card.id}" bind:value={target} class="border-border bg-background rounded-[7px] border px-2 text-xs" style="min-height:var(--tap)">
            {#each targets as s, i (s.key)}<option value={s.key}>{s.name}{i === 0 ? ' (this stage)' : ''}</option>{/each}
          </select>
        </div>
      {/if}
      <ResumeBox id="drawer-resume-{card.id}" onSubmit={submit} />
    </div>
  </section>
{/if}

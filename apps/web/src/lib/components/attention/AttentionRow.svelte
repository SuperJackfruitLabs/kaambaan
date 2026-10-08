<script lang="ts">
  /**
   * One card waiting on a person: what happened (in the card's own words), what to do, and the
   * actions that do it. Everything from the card — title, detail — is rendered as text.
   *
   * A review row has no Approve: the row says what is being approved and opens the card, where
   * the decision sits next to the work.
   */
  import type { Stage } from '$lib/api';
  import { KIND_LABEL, type AttentionItem } from './attention';
  import ResumeBox from './ResumeBox.svelte';

  let {
    item,
    stages = [],
    showBoard = false,
    onOpen,
    onResume,
    onMove,
  }: {
    item: AttentionItem;
    /** The board's stages, for the Move picker. */
    stages?: Stage[];
    /** Name the board too — the workspace list spans boards. */
    showBoard?: boolean;
    onOpen: (item: AttentionItem) => void;
    /** Resolves to the refusal to show, or null when it worked. */
    onResume: (item: AttentionItem, comment: string) => Promise<string | null>;
    onMove?: (item: AttentionItem, stageKey: string) => Promise<string | null>;
  } = $props();

  const CUT = 140;
  let expanded = $state(false);
  let resuming = $state(false);
  let moving = $state(false);
  let target = $state('');
  let moveError = $state<string | null>(null);

  const long = $derived((item.detail?.length ?? 0) > CUT);
  const shown = $derived(item.detail === null ? null : long && !expanded ? `${item.detail.slice(0, CUT).trimEnd()}…` : item.detail);
  const moveTargets = $derived(stages.filter((s) => s.key !== item.stageKey));
  const urgent = $derived(['review', 'failed', 'repeated-failure', 'blocked'].includes(item.kind));
  const age = $derived(
    item.ageHours === null ? null : item.ageHours < 1 ? 'just now' : item.ageHours < 48 ? `${Math.floor(item.ageHours)}h` : `${Math.floor(item.ageHours / 24)}d`,
  );

  async function move(): Promise<void> {
    if (!onMove || !target) return;
    moveError = await onMove(item, target);
    if (!moveError) moving = false;
  }
</script>

<div data-attention-row={item.kind} class="border-border grid gap-2 border-b px-3.5 py-2.5 last:border-b-0">
  <div class="flex flex-wrap items-start gap-2.5">
    <span
      class="mono mt-0.5 shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px] tracking-wider uppercase"
      style="color:{urgent ? 'var(--coral)' : item.kind === 'question' ? 'var(--marigold)' : 'var(--muted)'};background:var(--inset)"
    >{KIND_LABEL[item.kind]}</span>

    <div class="min-w-[10rem] flex-1">
      <button onclick={() => onOpen(item)} class="block text-left text-[13px] leading-snug hover:underline">{item.title}</button>
      <span class="mono text-muted-foreground block text-[11px] leading-snug">
        {#if showBoard && item.boardName}{item.boardName} · {/if}{item.headline}{#if age} · {age}{/if}
      </span>
      {#if shown !== null}
        <p class="mt-1 text-[12px] leading-snug break-words whitespace-pre-wrap">{shown}</p>
        {#if long}
          <button onclick={() => (expanded = !expanded)} class="text-muted-foreground hover:text-foreground text-[11px] underline">{expanded ? 'Show less' : 'Show all'}</button>
        {/if}
      {/if}
      <p class="text-muted-foreground mt-1 text-[11px] leading-snug">{item.instruction}</p>
    </div>

    <div class="flex flex-wrap gap-1.5">
      {#each item.actions as action (action)}
        {#if action === 'resume'}
          <button onclick={() => (resuming = !resuming)} aria-expanded={resuming} class="bg-primary text-primary-foreground rounded-[7px] px-2.5 text-xs font-semibold" style="min-height:var(--tap)">Resume</button>
        {:else if action === 'review'}
          <button onclick={() => onOpen(item)} class="bg-primary text-primary-foreground rounded-[7px] px-2.5 text-xs font-semibold" style="min-height:var(--tap)">Review</button>
        {:else if action === 'answer'}
          <button onclick={() => onOpen(item)} class="bg-primary text-primary-foreground rounded-[7px] px-2.5 text-xs font-semibold" style="min-height:var(--tap)">Answer</button>
        {:else if action === 'log'}
          <button onclick={() => onOpen(item)} class="border-border hover:border-marigold rounded-[7px] border px-2.5 text-xs" style="min-height:var(--tap)">Open log</button>
        {:else if action === 'staff'}
          <a href="/workspace/capabilities" class="border-border hover:border-marigold inline-flex items-center rounded-[7px] border px-2.5 text-xs" style="min-height:var(--tap)">Staff an agent</a>
        {:else if action === 'move' && onMove}
          <button onclick={() => (moving = !moving)} aria-expanded={moving} class="bg-primary text-primary-foreground rounded-[7px] px-2.5 text-xs font-semibold" style="min-height:var(--tap)">Move</button>
        {:else if action === 'open'}
          <button onclick={() => onOpen(item)} class="border-border hover:border-marigold rounded-[7px] border px-2.5 text-xs" style="min-height:var(--tap)">Open</button>
        {/if}
      {/each}
    </div>
  </div>

  {#if resuming}
    <ResumeBox id="resume-{item.id}" onSubmit={(c) => onResume(item, c)} onCancel={() => (resuming = false)} />
  {/if}

  {#if moving}
    <div class="flex flex-wrap items-center gap-2">
      <label for="move-{item.id}" class="text-muted-foreground text-[11px]">Move to</label>
      <select id="move-{item.id}" bind:value={target} class="border-border bg-background rounded-[7px] border px-2 text-xs" style="min-height:var(--tap)">
        <option value="" disabled>Choose a stage</option>
        {#each moveTargets as s (s.key)}<option value={s.key}>{s.name}</option>{/each}
      </select>
      <button onclick={() => void move()} disabled={!target} class="bg-primary text-primary-foreground rounded-[7px] px-2.5 text-xs font-semibold disabled:opacity-50" style="min-height:var(--tap)">Move card</button>
      {#if moveError}<p class="text-coral w-full text-xs" role="alert">{moveError}</p>{/if}
    </div>
  {/if}
</div>

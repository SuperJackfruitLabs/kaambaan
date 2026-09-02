<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import {
    getCardActivities,
    getAttempts,
    getEstimate,
    updateCard,
    deleteCard,
    addReference,
    resolveGate,
    answerElicitation,
    type CardActivities,
    type Attempt,
    type Estimate,
    type GateDecision,
  } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { agentColor, initialOf } from '$lib/components/agentColor';

  // ---- derived from store ----
  const cardId = $derived(app.openCardId);
  const card = $derived(cardId ? app.cardById(cardId) : undefined);
  const gate = $derived(cardId ? app.gateForCard(cardId) : undefined);
  const elicitation = $derived(cardId ? app.elicitationForCard(cardId) : undefined);
  const refs = $derived(cardId ? app.referencesForCard(cardId) : []);
  const boardId = $derived(app.boardId);
  const stageName = $derived(
    card && app.board ? (app.board.stages.find((s) => s.key === card.currentStageKey)?.name ?? card.currentStageKey) : '',
  );

  // ---- local async state ----
  let cardDetail = $state<CardActivities | null>(null);
  /** Gates that have been decided — the pending one is rendered by its own control above. */
  const decidedGates = $derived((cardDetail?.gates ?? []).filter((g) => g.status !== 'pending'));
  let drawerAttempts = $state<Attempt[]>([]);
  let cardEstimate = $state<Estimate | null>(null);

  // ---- edit state ----
  let editing = $state(false);
  let editTitle = $state('');
  let editPriority = $state(0);
  let editDesc = $state('');
  let editLabels = $state('');
  let editAC = $state('');
  // `spec.due` was rendered on every card tile and no interface could write it: a field that
  // appeared on the card and that a person could not fill in.
  let editDue = $state('');
  let savingCard = $state(false);
  let newRefUrl = $state('');
  let localError = $state<string | null>(null);

  // ---- elicitation (agent question) state ----
  let answerText = $state('');
  let answering = $state(false);

  // ---- gate state ----
  // which option is interactive (request_changes) — shows comment textarea
  let activeInteractiveOption = $state<string | null>(null);
  let gateComment = $state('');

  // ---- refresh drawer data when card opens / changes ----
  $effect(() => {
    const id = cardId;
    if (id && boardId) {
      answerText = '';
      gateComment = '';
      activeInteractiveOption = null;
      editing = false;
      newRefUrl = '';
      localError = null;
      void refreshDrawer(id, boardId);
    } else {
      cardDetail = null;
      drawerAttempts = [];
      cardEstimate = null;
    }
  });

  async function refreshDrawer(id: string, bid: string): Promise<void> {
    try {
      [cardDetail, drawerAttempts, cardEstimate] = await Promise.all([
        getCardActivities(bid, id),
        getAttempts(bid, id),
        getEstimate(bid, id),
      ]);
    } catch {
      /* best-effort */
    }
  }

  // ---- close ----
  function close(): void {
    app.closeCard();
  }

  // ---- edit ----
  function startEdit(): void {
    if (!card) return;
    editTitle = card.title;
    editPriority = card.priority;
    editDesc = (card.spec?.description as string | undefined) ?? '';
    const existingLabels = Array.isArray(card.spec?.labels) ? (card.spec!.labels as string[]) : [];
    editLabels = existingLabels.join(', ');
    const existingAC = Array.isArray(card.spec?.acceptanceCriteria) ? (card.spec!.acceptanceCriteria as string[]) : [];
    editAC = existingAC.join('\n');
    editDue = typeof card.spec?.due === 'string' ? card.spec.due : '';
    editing = true;
  }

  async function saveCard(): Promise<void> {
    if (!boardId || !cardId || editTitle.trim() === '') return;
    savingCard = true;
    try {
      const labels = editLabels.split(',').map((l) => l.trim()).filter(Boolean);
      const ac = editAC.split('\n').map((l) => l.trim()).filter(Boolean);
      const spec = {
        ...(card?.spec ?? {}),
        description: editDesc,
        labels,
        acceptanceCriteria: ac,
        // Omitted rather than set to '' when cleared, so "no due date" is the absence the tile
        // already tests for rather than an empty string that reads as a date.
        ...(editDue.trim() === '' ? { due: undefined } : { due: editDue.trim() }),
      };
      if (editDue.trim() === '') delete (spec as Record<string, unknown>).due;
      const res = await updateCard(boardId, cardId, { title: editTitle.trim(), priority: Number(editPriority) || 0, spec });
      if (!res.ok) localError = `Couldn't save the card (${res.status})`;
      editing = false;
      await app.refresh();
      if (cardId && boardId) void refreshDrawer(cardId, boardId);
    } finally {
      savingCard = false;
    }
  }

  /**
   * Reassign the card.
   *
   * A card's owner was fixed to whoever created it — no reassign, no "assign to me", no unassign —
   * on a board whose whole purpose is handing work between people and agents. Deliberately does
   * NOT touch `queuedBy`: who is answerable for a card and who authorised its dispatch are
   * different questions, and the second is what a claim is checked against.
   */
  let assigning = $state(false);
  async function assignToMe(): Promise<void> {
    if (!boardId || !cardId || !app.user) return;
    assigning = true;
    try {
      const res = await updateCard(boardId, cardId, { ownerUserId: app.user.userId });
      if (!res.ok) localError = `Couldn't reassign the card (${res.status})`;
      await app.refresh();
    } finally {
      assigning = false;
    }
  }

  async function onDeleteCard(): Promise<void> {
    if (!boardId || !cardId) return;
    if (!confirm('Delete this card and its history? This cannot be undone.')) return;
    const res = await deleteCard(boardId, cardId);
    if (res.ok) {
      close();
      await app.refresh();
    } else {
      localError = `Couldn't delete the card (${res.status})`;
    }
  }

  async function addRef(): Promise<void> {
    if (!boardId || !cardId || newRefUrl.trim() === '') return;
    const res = await addReference(boardId, cardId, { url: newRefUrl.trim() });
    if (res.ok) {
      newRefUrl = '';
      await app.refresh();
    } else {
      localError = `Couldn't add that link (${res.status})`;
    }
  }

  // ---- gate resolution ----
  async function onResolve(decision: GateDecision): Promise<void> {
    if (!boardId || !gate) return;
    const comment = gateComment.trim() || undefined;
    const res = await resolveGate(boardId, gate.id, decision, comment);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      localError = body?.error?.message ?? `Resolve failed (${res.status})`;
      await app.refresh();
      return;
    }
    localError = null;
    await app.refresh();
    app.closeCard();
  }

  // ---- answering an agent's question (docs/04 §4) ----
  // The agent is blocked and still holding its lease; the answer is what lets it carry on, so a
  // failure here has to say so rather than quietly leaving the card parked.
  async function onAnswer(option?: string): Promise<void> {
    if (!boardId || !elicitation || answering) return;
    const text = answerText.trim();
    if (!option && text === '') {
      localError = elicitation.options.length > 0 ? 'Pick one of the options.' : 'Type an answer first.';
      return;
    }
    answering = true;
    try {
      const res = await answerElicitation(boardId, elicitation.id, { option, text: text || undefined });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        localError = body?.error?.message ?? `Couldn't send that answer (${res.status})`;
      } else {
        localError = null;
        answerText = '';
      }
      await app.refresh();
      if (cardId && boardId) void refreshDrawer(cardId, boardId);
    } finally {
      answering = false;
    }
  }

  // ---- helpers ----
  function activityMarker(type: string): { glyph: string; cssClass: string } {
    if (type === 'action') return { glyph: '▸', cssClass: 'act-action' };
    if (type === 'response') return { glyph: '◆', cssClass: 'act-response' };
    if (type === 'error') return { glyph: '✕', cssClass: 'act-error' };
    if (type === 'elicitation') return { glyph: '⚑', cssClass: 'act-elicitation' };
    if (type === 'prompt') return { glyph: '✎', cssClass: 'act-response' }; // the human's turn
    return { glyph: '◇', cssClass: 'act-thought' };
  }

  function fmtTime(ts: string): string {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return ts;
    }
  }

  function fmtUsd(n: number): string {
    return `$${n.toFixed(2)}`;
  }

  // Defense-in-depth: never emit non-http(s) href
  function safeHref(url: string): string | null {
    return /^https?:\/\//i.test(url) ? url : null;
  }

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

  function subStateLabel(ref: (typeof refs)[number]): string | null {
    const s = ref.metadata?.subState;
    return typeof s === 'string' ? (SUB_STATE_LABELS[s] ?? s) : null;
  }

  function refLabel(ref: (typeof refs)[number]): string {
    if (ref.sourceType === 'pull_request') return `PR ${ref.externalId?.split('#')[1] ? `#${ref.externalId.split('#')[1]}` : ''}`.trim();
    if (ref.sourceType === 'issue') return `Issue ${ref.externalId?.split('#')[1] ? `#${ref.externalId.split('#')[1]}` : ''}`.trim();
    if (ref.sourceType === 'repo') return ref.externalId ?? 'repo';
    return ref.title ?? ref.sourceType;
  }

  // plan helpers
  const planItems = $derived(
    Array.isArray(card?.spec?.plan) ? (card!.spec!.plan as Array<{ t: string; done: boolean }>) : null,
  );
  const planDone = $derived(planItems ? planItems.filter((s) => s.done).length : 0);
  const planPct = $derived(planItems && planItems.length > 0 ? Math.round((planDone / planItems.length) * 100) : 0);

  const acceptanceCriteria = $derived(
    Array.isArray(card?.spec?.acceptanceCriteria) ? (card!.spec!.acceptanceCriteria as string[]) : null,
  );

  // cost
  const costPct = $derived(
    card && cardEstimate?.estimatedUsd && cardEstimate.estimatedUsd > 0
      ? Math.min(100, Math.round((card.costUsd / cardEstimate.estimatedUsd) * 100))
      : 0,
  );

  // agent avatar
  const delegateId = $derived(card?.delegateAgentId ?? null);
  const delegateColor = $derived(agentColor(delegateId));
  const delegateInitial = $derived(initialOf(delegateId));

  // state pill
  function statePillClass(state: string): string {
    if (state === 'working') return 'statepill statepill-working';
    if (state === 'gate' || gate) return 'statepill statepill-gate';
    if (state === 'done') return 'statepill statepill-done';
    return 'statepill statepill-ready';
  }
  function statePillLabel(state: string): string {
    if (state === 'working') return 'working';
    if (gate) return 'input-required';
    if (state === 'done') return 'completed';
    return 'ready';
  }
</script>

{#if card}
  <div class="fixed inset-0 z-30 flex justify-end">
    <!-- scrim -->
    <button class="absolute inset-0 bg-black/55" onclick={close} aria-label="Close drawer" tabindex="-1"></button>

    <!-- drawer panel -->
    <aside class="bg-surface border-border drawer-in relative flex h-full w-full flex-col border-l shadow-2xl sm:max-w-[520px]">

      <!-- dw-head -->
      <div class="dw-head border-border border-b p-4 pb-3.5 flex-none">
        {#if editing}
          <!-- edit form -->
          <div class="min-w-0 flex-1">
            <div class="eyebrow mb-2">edit card</div>
            <input bind:value={editTitle} placeholder="Title" class="bg-inset border-border focus:border-marigold w-full rounded-[6px] border px-2.5 py-1.5 text-sm outline-none" />
            <div class="mt-2 flex flex-wrap items-center gap-3">
              <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">
                priority
                <input type="number" bind:value={editPriority} class="bg-inset border-border focus:border-marigold w-16 rounded-[5px] border px-1.5 py-1 outline-none" />
              </label>
              <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">
                due
                <input type="date" bind:value={editDue} aria-label="Due date" class="bg-inset border-border focus:border-marigold rounded-[5px] border px-1.5 py-1 outline-none" />
              </label>
              {#if editDue !== ''}
                <button onclick={() => (editDue = '')} class="text-muted-foreground hover:text-foreground mono text-[11px]">clear</button>
              {/if}
            </div>
            <textarea bind:value={editDesc} rows="3" placeholder="Description / brief for the agent…" class="bg-inset border-border focus:border-marigold mt-2 w-full resize-none rounded-[6px] border px-2.5 py-2 text-xs outline-none"></textarea>
            <label for="edit-labels" class="text-muted-foreground mono mt-3 block text-[11px] uppercase tracking-widest">Labels <span class="normal-case">(comma-separated)</span></label>
            <input
              id="edit-labels"
              bind:value={editLabels}
              placeholder="bug, frontend, urgent"
              class="bg-inset border-border focus:border-marigold mt-1 w-full rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
            />
            <label for="edit-ac" class="text-muted-foreground mono mt-3 block text-[11px] uppercase tracking-widest">Acceptance Criteria <span class="normal-case">(one per line)</span></label>
            <textarea
              id="edit-ac"
              bind:value={editAC}
              rows="3"
              placeholder={"User can log in\nError messages are shown\nAll tests pass"}
              class="bg-inset border-border focus:border-marigold mt-1 w-full resize-none rounded-[6px] border px-2.5 py-2 text-xs outline-none"
            ></textarea>
            <div class="mt-2.5 flex gap-1.5">
              <Button size="sm" onclick={saveCard} disabled={savingCard || editTitle.trim() === ''}>{savingCard ? 'Saving…' : 'Save'}</Button>
              <Button size="sm" variant="ghost" onclick={() => (editing = false)}>Cancel</Button>
            </div>
          </div>
        {:else}
          <!-- dw-crumbs row -->
          <div class="dw-crumbs mb-2 flex items-center gap-2">
            <span class="dw-stage eyebrow" style="color:var(--marigold)">{stageName}</span>
            <button onclick={close} class="text-muted-foreground hover:text-foreground hover:bg-accent ml-auto rounded-[7px] p-1" aria-label="Close" title="close (esc)">
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>

          <!-- dw-title -->
          <div class="flex items-start gap-2">
            <h2 class="wordmark dw-title text-[17px] font-semibold leading-snug flex-1 min-w-0">{card.title}</h2>
            <button onclick={startEdit} aria-label="Edit card" title="Edit card" class="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded-[7px] p-1.5">
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
          </div>

          <!-- status row -->
          <div class="statusrow mt-2.5 flex flex-wrap items-center gap-2.5">
            <!-- state pill -->
            <span class={statePillClass(card.state)}>{statePillLabel(card.state)}</span>

            <!-- delegate agent -->
            {#if delegateId}
              <span class="delegate inline-flex items-center gap-1.5 font-mono text-[11px]" style="color:var(--muted)">
                <span class="inline-flex size-[18px] items-center justify-center rounded-full text-[9px] font-semibold shrink-0" style="background:{delegateColor};color:#0f1118">{delegateInitial}</span>
                <span>{delegateId} · delegate</span>
              </span>
            {/if}

            <!-- owner -->
            <span class="delegate inline-flex items-center gap-1 font-mono text-[11px]" style="color:var(--muted)">owner · {card.ownerUserId}</span>
            {#if app.user && card.ownerUserId !== app.user.userId}
              <button
                onclick={() => void assignToMe()}
                disabled={assigning}
                class="text-muted-foreground hover:text-foreground font-mono text-[11px] underline disabled:opacity-40"
              >{assigning ? 'assigning…' : 'assign to me'}</button>
            {/if}

            <!-- live ephemeral -->
            {#if card.state === 'working'}
              <span class="ephemeral inline-flex items-center gap-1.5 font-mono text-[11.5px]" style="color:var(--live)">
                <span class="live-dot"></span>
              </span>
            {/if}
          </div>
        {/if}
      </div>

      <!-- dw-body -->
      <div class="dw-body flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">

        {#if localError}
          <p role="alert" class="border-coral/40 text-coral mono rounded-[7px] border px-3 py-2 text-xs" style="background:rgba(255,107,87,.08)">{localError}</p>
        {/if}

        <!-- description from spec -->
        {#if card.spec?.description}
          <section class="sec">
            <div class="sec-h eyebrow">description</div>
            <p class="text-foreground/90 text-sm leading-relaxed whitespace-pre-wrap">{String(card.spec.description)}</p>
          </section>
        {/if}

        <!-- the agent's open question — the card is parked until someone answers it -->
        {#if elicitation}
          <section class="sec">
            <div class="elicitation border rounded-[10px] p-3.5" style="border-color:rgba(255,107,87,.35);background:rgba(255,107,87,.06)">
              <div class="mb-2 flex items-center gap-2">
                <span class="wordmark font-semibold text-sm" style="color:var(--coral)">
                  ⚑ {elicitation.signal === 'auth' ? 'awaiting your sign-in' : 'awaiting your answer'}
                </span>
                <span class="eyebrow ml-auto">{elicitation.agentId} is waiting</span>
              </div>
              <p class="mb-3 text-[13px] leading-relaxed whitespace-pre-wrap">{elicitation.question}</p>

              {#if elicitation.options.length > 0}
                <div class="flex flex-wrap gap-2">
                  {#each elicitation.options as opt (opt.name)}
                    <Button size="sm" variant={opt.name === elicitation.options[0]?.name ? 'default' : 'outline'} disabled={answering} onclick={() => onAnswer(opt.name)}>
                      {opt.title}
                    </Button>
                  {/each}
                </div>
                <textarea
                  bind:value={answerText}
                  rows="2"
                  placeholder="Add a note for the agent (optional)…"
                  class="bg-inset border-border mt-2.5 w-full resize-none rounded-[7px] border px-2.5 py-2 text-xs outline-none"
                  style="border-color:rgba(255,107,87,.4)"
                ></textarea>
              {:else}
                <textarea
                  bind:value={answerText}
                  rows="3"
                  placeholder="Your answer — this goes straight back to the waiting agent…"
                  class="bg-inset border-border w-full resize-none rounded-[7px] border px-2.5 py-2 text-xs outline-none"
                  style="border-color:rgba(255,107,87,.4)"
                ></textarea>
                <div class="mt-2 flex justify-end">
                  <Button size="sm" disabled={answering} onclick={() => onAnswer()}>Send answer</Button>
                </div>
              {/if}
            </div>
          </section>
        {/if}

        <!-- gate panel — only when a pending gate exists -->
        {#if gate}
          {@const effectiveOptions = gate.options.length > 0
            ? gate.options
            : [
                { name: 'approve', title: 'Approve', interactive: false },
                { name: 'request_changes', title: 'Request changes', interactive: true },
                { name: 'reject', title: 'Reject', interactive: false },
              ]}
          <section class="sec">
            <div class="gate border rounded-[10px] p-3.5" style="border-color:rgba(255,107,87,.35);background:rgba(255,107,87,.06)">
              <div class="gh mb-2.5 flex items-center gap-2">
                <span class="wordmark font-semibold text-sm" style="color:var(--coral)">⚑ awaiting your review</span>
              </div>

              <!-- gate action buttons — driven by effectiveOptions -->
              <div class="triad flex gap-2 flex-wrap">
                {#each effectiveOptions as opt (opt.name)}
                  {#if opt.name === 'approve'}
                    <Button
                      size="sm"
                      onclick={() => onResolve('approve')}
                      class="flex-1"
                    >{opt.title}</Button>
                  {:else if opt.name === 'request_changes'}
                    <Button
                      size="sm"
                      variant="outline"
                      onclick={() => {
                        activeInteractiveOption = activeInteractiveOption === 'request_changes' ? null : 'request_changes';
                      }}
                      class="flex-1"
                    >{opt.title}</Button>
                  {:else if opt.name === 'reject'}
                    <Button
                      size="sm"
                      variant="ghost"
                      onclick={() => onResolve('reject')}
                      class="flex-1"
                    >{opt.title}</Button>
                  {/if}
                {/each}
              </div>

              <!-- request_changes comment box -->
              {#if activeInteractiveOption === 'request_changes'}
                <div class="reject-box mt-3">
                  <textarea
                    bind:value={gateComment}
                    rows="3"
                    placeholder="What needs to change? This feedback threads into the agent's next attempt…"
                    class="bg-inset border-border focus:border-coral w-full resize-none rounded-[7px] border px-2.5 py-2 text-xs outline-none"
                    style="border-color:rgba(255,107,87,.4)"
                  ></textarea>
                  <div class="mt-2 flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onclick={() => { activeInteractiveOption = null; gateComment = ''; }}>Cancel</Button>
                    <Button size="sm" variant="outline" onclick={() => onResolve('request_changes')}>Send feedback</Button>
                  </div>
                </div>
              {/if}
            </div>
          </section>
        {/if}

        <!-- plan checklist (from card.spec.plan) -->
        {#if planItems && planItems.length > 0}
          <section class="sec">
            <div class="sec-h eyebrow flex items-center gap-2">
              agent plan
              <span class="ml-auto" style="color:var(--live)">{planPct}%</span>
            </div>
            <div class="plan flex flex-col gap-0.5">
              {#each planItems as step, i (i)}
                <div class="step flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-sm {step.done ? 'step-done' : ''}">
                  <span class="step-box flex size-4 shrink-0 items-center justify-center rounded-[5px] border text-[10px] {step.done ? 'step-box-done' : 'border-border'}">
                    {#if step.done}✓{/if}
                  </span>
                  <span class="step-t {step.done ? 'text-muted-foreground line-through' : ''}">{step.t}</span>
                </div>
              {/each}
            </div>
            <!-- rollup bar -->
            <div class="rollup mt-2 h-[5px] overflow-hidden rounded-full bg-inset">
              <div class="h-full rounded-full transition-all duration-1000" style="width:{planPct}%;background:var(--live)"></div>
            </div>
            <div class="eyebrow mt-1.5">{planDone} / {planItems.length} steps · {planPct}%</div>
          </section>
        {/if}

        <!-- acceptance criteria (from card.spec.acceptanceCriteria) -->
        {#if acceptanceCriteria && acceptanceCriteria.length > 0}
          <section class="sec">
            <div class="sec-h eyebrow">acceptance criteria</div>
            <ul class="ac bg-inset border-border list-disc rounded-[7px] border px-4 py-3 text-[12.5px] space-y-1">
              {#each acceptanceCriteria as criterion, i (i)}
                <li style="color:var(--text)">{criterion}</li>
              {/each}
            </ul>
          </section>
        {/if}

        <!-- activity stream -->
        <section class="sec">
          <div class="sec-h eyebrow">session activity</div>
          {#if !cardDetail || cardDetail.activities.length === 0}
            <p class="text-muted-foreground text-xs">No recorded activity yet — this card hasn't been worked.</p>
          {:else}
            <div class="stream flex flex-col gap-0.5">
              {#each cardDetail.activities as a (a.seq)}
                {@const m = activityMarker(a.type)}
                <div class="act {m.cssClass} grid rounded-[6px] px-1.5 py-1.5 text-[12.5px] items-start" style="grid-template-columns:18px 1fr auto;gap:9px">
                  <span class="act-icon text-[12px] text-center pt-px">{m.glyph}</span>
                  <div class="act-body min-w-0">
                    <span class="act-k font-mono text-[9.5px] uppercase tracking-wider mr-1.5" style="color:var(--muted)">{a.type}</span>
                    {#if a.action}
                      <span class="font-mono text-[11px]" style="color:var(--marigold)">{a.action}</span>
                      {#if a.parameter}<span class="text-muted-foreground font-mono text-[11px]"> {JSON.stringify(a.parameter).slice(0, 140)}</span>{/if}
                    {/if}
                    {#if a.body}<div class="mt-0.5 text-xs leading-relaxed {a.type === 'error' || a.type === 'elicitation' ? 'text-coral' : 'text-foreground/90'}">{a.body}</div>{/if}
                  </div>
                  <span class="act-ts text-muted-foreground font-mono text-[10px] whitespace-nowrap pt-px">{fmtTime(a.ts)}</span>
                </div>
              {/each}
            </div>
            {#if card.state === 'working'}
              <div class="streamcap mt-2 flex items-center gap-2 font-mono text-[10.5px]" style="color:var(--muted)">
                <span class="live-dot"></span> streaming live…
              </div>
            {/if}
          {/if}
        </section>

        <!--
          Approval history.

          `gates.decided_by` and `gates.comment` were written on every resolution and appeared in
          no read shape at all, so who approved a card — and the feedback they gave with it — was
          recorded and unreadable. An approval nobody can attribute is not much of an approval.
        -->
        {#if decidedGates.length > 0}
          <section class="sec">
            <div class="sec-h eyebrow">decisions</div>
            <div class="space-y-1.5">
              {#each decidedGates as g (g.id)}
                <div class="bg-inset border-border rounded-[8px] border px-3 py-2 text-[11px]">
                  <div class="flex items-center gap-1.5">
                    <span class="mono" style="color:{g.decision === 'approve' ? 'var(--live)' : 'var(--coral)'}">{g.decision ?? g.status}</span>
                    <span class="text-muted-foreground">at</span>
                    <span class="mono">{g.stageKey}</span>
                    {#if g.decidedBy}
                      <span class="text-muted-foreground">by</span>
                      <span class="mono truncate">{g.decidedBy}</span>
                    {/if}
                  </div>
                  {#if g.comment}
                    <p class="text-muted-foreground mt-1 leading-relaxed">{g.comment}</p>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}

        <!-- handoff from prior stage -->
        {#if cardDetail?.handoff && Object.keys(cardDetail.handoff).length > 0}
          <section class="sec">
            <div class="sec-h eyebrow">handoff from prior stage</div>
            <div class="bg-inset border-border mono space-y-1 rounded-[8px] border p-3 text-[11px]">
              {#each Object.entries(cardDetail.handoff) as [k, v] (k)}
                <div><span class="text-muted-foreground">{k}:</span> {typeof v === 'string' ? v : JSON.stringify(v)}</div>
              {/each}
            </div>
          </section>
        {/if}

        <!-- cost block -->
        {#if card.costUsd > 0 || cardEstimate?.estimatedUsd}
          <section class="sec">
            <div class="sec-h eyebrow">cost</div>
            <div class="costblock flex items-baseline gap-2 font-mono">
              <span class="text-[21px] font-semibold" style="color:var(--text)">{fmtUsd(card.costUsd)}</span>
              {#if cardEstimate?.estimatedUsd !== null && cardEstimate?.estimatedUsd !== undefined}
                <span class="text-[11.5px]" style="color:var(--muted)">
                  / {fmtUsd(cardEstimate.estimatedUsd)} estimate
                  {#if card.overBudget}<span style="color:var(--coral)"> · over budget</span>{/if}
                  {#if cardEstimate.sampleSize > 0}<span title="{cardEstimate.sampleSize} similar run{cardEstimate.sampleSize === 1 ? '' : 's'}"> · {cardEstimate.sampleSize}× sample</span>{/if}
                </span>
              {/if}
            </div>
            <div class="costmeter mt-2 h-1.5 overflow-hidden rounded-full bg-inset {card.overBudget ? 'costmeter-over' : ''}">
              <div class="h-full rounded-full transition-all duration-1000" style="width:{costPct}%;background:{card.overBudget ? 'var(--coral)' : 'var(--live)'}"></div>
            </div>
          </section>
        {/if}

        <!-- attempts (if > 1) -->
        {#if drawerAttempts.length > 1}
          <section class="sec">
            <div class="sec-h eyebrow">attempts · {drawerAttempts.length}</div>
            <div class="space-y-1.5">
              {#each drawerAttempts as a, i (a.runId)}
                <div class="bg-inset border-border mono flex items-center justify-between gap-2 rounded-[7px] border px-2.5 py-1.5 text-[11px]">
                  <span class="text-muted-foreground truncate">{i + 1} · {a.agentId}{a.profileKey ? ` · ${a.profileKey}` : a.model ? ` · ${a.model}` : ''}</span>
                  <span class="shrink-0">{fmtUsd(a.costUsd)}{a.outcome ? ` · ${a.outcome}` : ''}</span>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        <!-- references -->
        <section class="sec">
          <div class="sec-h eyebrow">references</div>
          {#if refs.length > 0}
            <div class="mb-2.5 flex flex-wrap gap-1.5">
              {#each refs as ref (ref.id)}
                {@const href = safeHref(ref.url)}
                {@const inner = `${refLabel(ref)}${subStateLabel(ref) ? ` · ${subStateLabel(ref)}` : ''}`}
                {#if href}
                  <a {href} target="_blank" rel="noreferrer" class="border-border hover:border-marigold/50 mono inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[10px]"><span style="color:var(--marigold)">↗</span>{inner}</a>
                {:else}
                  <span class="border-border mono inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[10px]">{inner}</span>
                {/if}
              {/each}
            </div>
          {/if}
          <div class="flex gap-1.5">
            <input
              bind:value={newRefUrl}
              placeholder="https://… attach a link"
              onkeydown={(e) => { if (e.key === 'Enter') addRef(); }}
              class="bg-inset border-border focus:border-marigold flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
            />
            <Button size="sm" variant="outline" onclick={addRef} disabled={newRefUrl.trim() === ''}>Add</Button>
          </div>
        </section>

        <!-- delete -->
        <div class="border-border/60 border-t pt-4">
          <button onclick={onDeleteCard} class="text-muted-foreground hover:text-coral text-xs">Delete card</button>
        </div>
      </div>
    </aside>
  </div>
{/if}

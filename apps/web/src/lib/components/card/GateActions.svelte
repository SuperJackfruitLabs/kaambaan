<script lang="ts">
  /**
   * The decision controls of a pending approval gate: one optional note, then the buttons.
   *
   * The note used to appear only after "Request changes" was clicked, so Approve and Reject went
   * out with no comment at all and every approval made in the UI was recorded with `comment: null`
   * (observed 2026-10-10). The note is now always on screen while a gate is pending and travels
   * with whichever decision is taken. Text only: it is bound as a value and never rendered as HTML.
   */
  import { Button } from '$lib/components/ui/button';
  import { resolveGate, type Gate, type GateDecision } from '$lib/api';
  import { gateDecisionForOption } from '$lib/gate-delivery';
  import { noteToComment, GATE_NOTE_MAX } from '$lib/gate-note';

  let {
    boardId,
    gate,
    /** Handles the server's answer (error display, refresh, closing). Resolves true when it was accepted. */
    onResponse,
  }: {
    boardId: string;
    gate: Gate;
    onResponse: (decision: GateDecision, res: Response) => Promise<boolean>;
  } = $props();

  let note = $state('');
  let needNote = $state(false);
  let busy = $state(false);
  let noteEl: HTMLTextAreaElement | undefined = $state();

  // A different gate is a different decision: do not carry a half-written note across cards.
  let lastGateId = $state<string | null>(null);
  $effect(() => {
    if (gate.id !== lastGateId) {
      lastGateId = gate.id;
      note = '';
      needNote = false;
    }
  });

  const options = $derived(
    gate.options.length > 0
      ? gate.options
      : [
          { name: 'approve', title: 'Approve', interactive: false },
          { name: 'request_changes', title: 'Request changes', interactive: true },
          { name: 'reject', title: 'Reject', interactive: false },
        ],
  );

  async function decide(decision: GateDecision): Promise<void> {
    if (busy) return;
    const comment = noteToComment(note);
    // Request changes is the rework instruction the next run reads: nothing said, nothing to do.
    if (decision === 'request_changes' && comment === undefined) {
      needNote = true;
      noteEl?.focus();
      return;
    }
    needNote = false;
    busy = true;
    try {
      const res = await resolveGate(boardId, gate.id, decision, comment, gate.approvalSubject);
      if (await onResponse(decision, res)) note = '';
    } finally {
      busy = false;
    }
  }
</script>

<div class="gate-note mb-3">
  <label for="gate-note-{gate.id}" class="text-muted-foreground mb-1 block text-xs">
    {needNote ? "Say what needs to change" : 'Add a note (optional)'}
  </label>
  <textarea
    id="gate-note-{gate.id}"
    bind:this={noteEl}
    bind:value={note}
    maxlength={GATE_NOTE_MAX}
    rows="3"
    aria-invalid={needNote}
    placeholder="Recorded with your decision. Request changes needs one: it threads into the agent's next attempt."
    class="bg-inset border-border focus:border-coral w-full resize-y rounded-[7px] border px-2.5 py-2 text-base outline-none"
    style="border-color:{needNote ? 'var(--coral)' : 'rgba(255,107,87,.4)'}"
  ></textarea>
  <div class="text-muted-foreground mono mt-1 text-right text-[11px]">{note.length} / {GATE_NOTE_MAX}</div>
</div>

<div class="triad flex flex-wrap gap-2">
  {#each options as opt (opt.name)}
    {#if opt.name === 'approve' || opt.name === 'approve_manual' || opt.name === 'approve_automatic'}
      <Button size="sm" disabled={busy} onclick={() => decide(gateDecisionForOption(opt.name))} class="flex-1" style="min-height:var(--tap)">{opt.title}</Button>
    {:else if opt.name === 'request_changes'}
      <Button size="sm" variant="outline" disabled={busy} onclick={() => decide('request_changes')} class="flex-1" style="min-height:var(--tap)">{opt.title}</Button>
    {:else if opt.name === 'reject'}
      <Button size="sm" variant="ghost" disabled={busy} onclick={() => decide('reject')} class="flex-1" style="min-height:var(--tap)">{opt.title}</Button>
    {/if}
  {/each}
</div>

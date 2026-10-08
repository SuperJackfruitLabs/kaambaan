<script lang="ts">
  /**
   * The comment a resume needs: what changed, or what to do differently.
   *
   * The comment is not optional. The server keeps it on the card's thread and hands it to the next
   * agent as feedback; a resume with nothing said sends the same work into the same wall.
   */
  let {
    onSubmit,
    onCancel,
    id = 'resume',
  }: {
    /** Resolves to the refusal to show, or null when it worked. */
    onSubmit: (comment: string) => Promise<string | null>;
    onCancel?: () => void;
    id?: string;
  } = $props();

  let comment = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(): Promise<void> {
    const text = comment.trim();
    if (text === '' || busy) return;
    busy = true;
    error = null;
    try {
      error = await onSubmit(text);
      if (!error) comment = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid w-full gap-1.5">
  <label for="{id}-comment" class="text-muted-foreground text-[11px]">What changed, or what should the agent do differently? It reads this.</label>
  <textarea
    id="{id}-comment"
    bind:value={comment}
    rows="3"
    maxlength="8000"
    class="border-border bg-background w-full rounded-[7px] border px-2 py-1.5 text-[13px]"
  ></textarea>
  {#if error}<p class="text-coral text-xs" role="alert">{error}</p>{/if}
  <div class="flex flex-wrap gap-2">
    <button
      type="button"
      onclick={() => void submit()}
      disabled={comment.trim() === '' || busy}
      class="bg-primary text-primary-foreground rounded-[7px] px-2.5 text-xs font-semibold disabled:opacity-50"
      style="min-height:var(--tap)"
    >Send back to work</button>
    {#if onCancel}
      <button type="button" onclick={onCancel} class="border-border rounded-[7px] border px-2.5 text-xs" style="min-height:var(--tap)">Cancel</button>
    {/if}
  </div>
</div>

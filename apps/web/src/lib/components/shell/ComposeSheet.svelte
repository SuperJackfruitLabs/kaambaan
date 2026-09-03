<script lang="ts">
  /**
   * Creating a card, with everything the API has always accepted.
   *
   * The old composer was a title field in the topbar plus a 15×16px `+` that opened a popover for
   * priority, due date and description — a control below the WCAG floor guarding fields that were
   * first-class in the API all along. Here they are simply fields.
   *
   * One component, two containers: a dialog at 900px and up, a full-screen sheet below, because a
   * four-field form on a phone should not be a floating box with the board showing round it.
   */
  import { app } from '$lib/stores/app.svelte';
  import { Button } from '$lib/components/ui/button';

  let { open = false, onClose }: { open?: boolean; onClose: () => void } = $props();

  let title = $state('');
  let priority = $state(0);
  let due = $state('');
  let description = $state('');
  let saving = $state(false);
  let titleEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (open) {
      // Focused on open, because the first thing a person wants to do here is type.
      queueMicrotask(() => titleEl?.focus());
    } else {
      title = '';
      priority = 0;
      due = '';
      description = '';
    }
  });

  async function submit(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    if (title.trim() === '') return;
    saving = true;
    try {
      await app.dispatchCard(title.trim(), { priority: Number(priority) || 0, description, due });
      onClose();
    } finally {
      saving = false;
    }
  }
</script>

{#if open}
  <div class="fixed inset-0 z-40 flex items-end justify-center min-[900px]:items-center">
    <button class="absolute inset-0 bg-black/55" onclick={onClose} aria-label="Close" tabindex="-1"></button>

    <form
      onsubmit={submit}
      class="bg-surface border-border drawer-in relative flex h-full w-full flex-col border shadow-2xl min-[900px]:h-auto min-[900px]:max-w-lg min-[900px]:rounded-[12px]"
    >
      <div class="border-border flex items-center justify-between gap-3 border-b p-4">
        <div>
          <div class="eyebrow mb-0.5">new card</div>
          <h2 class="wordmark text-base leading-snug">{app.board?.name ?? 'Board'}</h2>
        </div>
        <button type="button" onclick={onClose} aria-label="Close" class="text-muted-foreground hover:text-foreground tap rounded-[7px]">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      <div class="flex-1 space-y-3 overflow-y-auto p-4">
        <input
          bind:this={titleEl}
          bind:value={title}
          aria-label="Card title"
          placeholder="What needs doing?"
          class="bg-inset border-border focus:border-marigold w-full rounded-[8px] border px-3 py-2.5 text-sm"
        />

        <div class="flex flex-wrap items-center gap-3">
          <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">
            priority
            <input type="number" bind:value={priority} min="0" class="bg-inset border-border focus:border-marigold w-16 rounded-[6px] border px-2 py-1.5" />
          </label>
          <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">
            due
            <input type="date" bind:value={due} aria-label="Due date" class="bg-inset border-border focus:border-marigold rounded-[6px] border px-2 py-1.5" />
          </label>
          {#if due !== ''}
            <button type="button" onclick={() => (due = '')} class="text-muted-foreground hover:text-foreground mono text-[11px]">clear</button>
          {/if}
        </div>

        <textarea
          bind:value={description}
          rows="4"
          aria-label="Description"
          placeholder="Brief for the agent — what done looks like, and anything it should not do."
          class="bg-inset border-border focus:border-marigold w-full resize-none rounded-[8px] border px-3 py-2 text-xs"
        ></textarea>
      </div>

      <div class="border-border flex justify-end gap-2 border-t p-4">
        <Button variant="ghost" onclick={onClose} type="button">Cancel</Button>
        <Button type="submit" disabled={saving || title.trim() === ''}>{saving ? 'Dispatching…' : 'Dispatch'}</Button>
      </div>
    </form>
  </div>
{/if}

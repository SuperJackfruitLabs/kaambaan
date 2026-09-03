<script lang="ts">
  /**
   * What happened — the notification feed, kept deliberately.
   *
   * The obvious simplification was to let "Needs you" replace the bell entirely. It cannot:
   * derived attention answers *what should I do*, and this answers *what happened*. Collapsing
   * them would silently drop every non-actionable notification — a card completing, a run being
   * reclaimed — which is a parity loss dressed up as a cleanup.
   */
  import { app } from '$lib/stores/app.svelte';
  import { markNotificationRead } from '$lib/api';

  let showRead = $state(false);

  const shown = $derived(showRead ? app.notifications : app.notifications.filter((n) => !n.read));
  const unread = $derived(app.unreadCount());

  async function markRead(seq: number): Promise<void> {
    if (!app.boardId) return;
    await markNotificationRead(app.boardId, seq);
    await app.refresh();
  }

  function when(iso: string): string {
    return iso.slice(11, 16);
  }
</script>

<section class="border-border bg-surface overflow-hidden rounded-[12px] border">
  <div class="border-border flex items-center gap-2 border-b px-3.5 py-2.5">
    <h2 class="text-sm font-semibold">Activity</h2>
    {#if unread > 0}<span class="mono text-[11px]" style="color:var(--marigold)">{unread} unread</span>{/if}
    <button
      onclick={() => (showRead = !showRead)}
      class="text-muted-foreground hover:text-foreground mono ml-auto text-[11px] underline underline-offset-2"
      style="min-height:var(--tap)"
    >{showRead ? 'unread only' : 'show all'}</button>
  </div>

  {#if shown.length === 0}
    <p class="text-muted-foreground px-3.5 py-4 text-sm">
      {showRead ? 'Nothing has happened on this board yet.' : 'Nothing unread.'}
    </p>
  {:else}
    <div class="max-h-80 overflow-y-auto">
      {#each shown as n (n.seq)}
        <div class="border-border flex items-start gap-2.5 border-b px-3.5 py-2 last:border-b-0 {n.read ? 'opacity-55' : ''}">
          <span class="mono text-muted-foreground w-9 shrink-0 pt-0.5 text-[10px]">{when(n.createdAt)}</span>
          <button onclick={() => app.openCard(n.cardId)} class="min-w-0 flex-1 text-left">
            <span class="mono block text-[10px] tracking-wider uppercase" style="color:var(--muted)">{n.kind}</span>
            <span class="block text-[12px] leading-snug">{n.body}</span>
          </button>
          {#if !n.read}
            <button onclick={() => void markRead(n.seq)} aria-label="Mark read" title="Mark read" class="text-muted-foreground hover:text-foreground tap shrink-0 rounded-[6px] text-[11px]">✓</button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>

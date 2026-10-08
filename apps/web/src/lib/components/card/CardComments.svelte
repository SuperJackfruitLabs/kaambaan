<script lang="ts">
  /**
   * A card's comment thread, inside the card drawer.
   *
   * Every body is rendered as TEXT with its line breaks kept (`white-space: pre-wrap`), never as
   * HTML. A comment is written by anyone with board read access, or by an agent, and read by
   * everyone who opens the card; `{@html}` here would let one comment run script in every viewer's
   * session. Markdown is stored as written and shown as its source — legible, and inert.
   *
   * Live: the board feed carries `card.comment.added` / `card.comment.deleted` naming the card (and
   * never the text), and this refetches the thread when one names this card.
   */
  import { getComments, postComment, deleteComment, type BoardFeedEvent, type CardComment } from '$lib/api';
  import { Button } from '$lib/components/ui/button';

  let {
    boardId,
    cardId,
    currentUserId,
    onFeed,
    coalesceMs = 250,
  }: {
    boardId: string;
    cardId: string;
    /** The signed-in person, so their own comments offer Delete. Null hides it everywhere. */
    currentUserId: string | null;
    /** The board's live feed (`app.onFeed`); returns its own unsubscribe. */
    onFeed: (fn: (e: BoardFeedEvent) => void) => () => void;
    coalesceMs?: number;
  } = $props();

  let comments = $state<CardComment[]>([]);
  let loaded = $state(false);
  let draft = $state('');
  let posting = $state(false);
  let error = $state<string | null>(null);

  async function load(bid: string, id: string): Promise<void> {
    try {
      const got = await getComments(bid, id);
      // The drawer may have moved to another card while this was in flight.
      if (bid === boardId && id === cardId) comments = got;
    } catch {
      // A failed read keeps what is on screen rather than blanking the thread.
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    const bid = boardId;
    const id = cardId;
    comments = [];
    loaded = false;
    error = null;
    void load(bid, id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onFeed((event) => {
      if (!event.type.startsWith('card.comment.') || event.payload?.cardId !== id) return;
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void load(bid, id);
      }, coalesceMs);
    });
    return () => {
      stop();
      if (timer !== undefined) clearTimeout(timer);
    };
  });

  async function refusal(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { error?: { message?: string } | string };
      const msg = typeof body.error === 'string' ? body.error : body.error?.message;
      if (msg) return msg;
    } catch {
      // fall through to the status
    }
    return `the server answered ${res.status}`;
  }

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (!text || posting) return;
    posting = true;
    error = null;
    try {
      const res = await postComment(boardId, cardId, text);
      if (!res.ok) {
        error = `Not posted: ${await refusal(res)}`;
        return;
      }
      draft = '';
      await load(boardId, cardId);
    } finally {
      posting = false;
    }
  }

  async function remove(c: CardComment): Promise<void> {
    if (!confirm('Delete this comment? The thread will show that a comment was deleted.')) return;
    const res = await deleteComment(boardId, cardId, c.id);
    if (!res.ok) {
      error = `Not deleted: ${await refusal(res)}`;
      return;
    }
    await load(boardId, cardId);
  }

  function when(ts: string): string {
    try {
      return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return ts;
    }
  }
</script>

{#if comments.length > 0}
  <ul class="mb-2.5 space-y-1.5" data-testid="comment-list">
    {#each comments as c (c.id)}
      <li class="bg-inset border-border min-w-0 rounded-[8px] border px-3 py-2 text-[12px]">
        <div class="mono flex min-w-0 flex-wrap items-center gap-x-1.5 text-[10.5px]">
          <span class="truncate font-semibold" title={c.author.id}>{c.author.name ?? c.author.id}</span>
          {#if c.author.kind === 'agent'}
            <span class="border-border text-muted-foreground rounded-[4px] border px-1 text-[9.5px]">agent</span>
          {/if}
          <time class="text-muted-foreground" datetime={c.createdAt}>{when(c.createdAt)}</time>
          {#if !c.deletedAt && c.author.kind === 'human' && currentUserId && c.author.id === currentUserId}
            <button
              type="button"
              class="text-muted-foreground hover:text-coral ml-auto min-h-6 px-1"
              aria-label="Delete your comment"
              onclick={() => void remove(c)}>Delete</button
            >
          {/if}
        </div>
        {#if c.deletedAt}
          <p class="text-muted-foreground mt-1 italic">Comment deleted</p>
        {:else}
          <p class="comment-body mt-1 leading-relaxed">{c.body}</p>
        {/if}
      </li>
    {/each}
  </ul>
{:else if loaded}
  <p class="text-muted-foreground mb-2 text-[11px]">No comments yet. The agent that works this card reads them.</p>
{/if}

<form
  class="flex flex-col gap-1.5 sm:flex-row sm:items-end"
  onsubmit={(e) => {
    e.preventDefault();
    void submit();
  }}
>
  <textarea
    bind:value={draft}
    aria-label="Add a comment"
    placeholder="Add a comment… (⌘/Ctrl+Enter to post)"
    rows="2"
    maxlength="8192"
    onkeydown={(e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    }}
    class="bg-inset border-border focus:border-marigold min-w-0 flex-1 resize-y rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
  ></textarea>
  <Button type="submit" size="sm" variant="outline" disabled={draft.trim() === '' || posting}>{posting ? 'Posting…' : 'Comment'}</Button>
</form>
{#if error}
  <p role="alert" class="text-coral mono mt-1.5 text-[11px]">{error}</p>
{/if}

<style>
  .comment-body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>

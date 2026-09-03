<script lang="ts">
  /**
   * The board, and how to change it.
   *
   * Replaces the rail's flat list, which rendered one button per board with no search, no grouping
   * and no limit — 305 of them in the database this was audited against, as one unbroken column.
   * The finding was not the 305; it was that nothing about the list changed between three boards
   * and three hundred.
   *
   * The search field appears past eight boards rather than always, because a search box over four
   * items is furniture.
   */
  import { goto } from '$app/navigation';
  import { app } from '$lib/stores/app.svelte';
  import { renameBoard } from '$lib/api';

  let open = $state(false);
  let query = $state('');
  let renaming = $state(false);
  let draftName = $state('');
  let menuEl = $state<HTMLDivElement | null>(null);

  const boards = $derived(app.boards);
  const current = $derived(app.board?.name ?? 'Board');
  const showSearch = $derived(boards.length > 8);
  const shown = $derived(
    query.trim() === '' ? boards : boards.filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase())),
  );

  function close(): void {
    open = false;
    query = '';
    renaming = false;
  }

  async function pick(id: string): Promise<void> {
    close();
    if (id !== app.boardId) await goto(`/b/${id}`);
  }

  async function saveRename(): Promise<void> {
    const name = draftName.trim();
    if (!app.boardId || name === '' || name === app.board?.name) return void (renaming = false);
    await renameBoard(app.boardId, name);
    await app.refresh();
    await app.loadBoards();
    renaming = false;
  }

  async function onDelete(): Promise<void> {
    const id = app.boardId;
    if (!id) return;
    const count = app.board?.cards.length ?? 0;
    const cards = count > 0 ? ` and its ${count} card${count === 1 ? '' : 's'}` : '';
    if (!confirm(`Delete "${app.board?.name}"${cards}? Its cards, runs and history go with it. This cannot be undone.`)) return;
    close();
    await app.deleteBoard(id);
    await goto('/');
  }
</script>

<svelte:window
  onclick={(e) => {
    if (open && menuEl && !menuEl.contains(e.target as Node)) close();
  }}
/>

<div class="relative" bind:this={menuEl}>
  <button
    onclick={() => (open = !open)}
    aria-expanded={open}
    aria-haspopup="menu"
    class="hover:bg-inset flex max-w-[14rem] items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-sm font-medium"
    style="min-height:var(--tap)"
  >
    <span class="truncate">{current}</span>
    <svg class="size-3 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
  </button>

  {#if open}
    <div role="menu" class="bg-surface border-border absolute top-full left-0 z-30 mt-1 w-72 rounded-[10px] border p-1.5 shadow-2xl">
      {#if showSearch}
        <input
          bind:value={query}
          placeholder="Find a board"
          aria-label="Find a board"
          class="bg-inset border-border focus:border-marigold mb-1.5 w-full rounded-[7px] border px-2.5 py-1.5 text-xs outline-none"
        />
      {/if}

      <div class="max-h-64 overflow-y-auto">
        {#each shown as b (b.id)}
          <button
            role="menuitem"
            onclick={() => void pick(b.id)}
            class="hover:bg-inset flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-sm {b.id === app.boardId ? 'text-marigold' : ''}"
          >
            <span class="truncate">{b.name}</span>
            {#if b.id === app.boardId}<span class="mono text-muted-foreground ml-auto shrink-0 text-[10px]">here</span>{/if}
          </button>
        {/each}
        {#if shown.length === 0}
          <p class="text-muted-foreground px-2.5 py-3 text-xs">No board matches “{query}”.</p>
        {/if}
      </div>

      <div class="border-border mt-1.5 border-t pt-1.5">
        {#if renaming}
          <div class="flex gap-1.5 px-1">
            <input
              bind:value={draftName}
              aria-label="Board name"
              onkeydown={(e) => { if (e.key === 'Enter') void saveRename(); if (e.key === 'Escape') renaming = false; }}
              class="bg-inset border-border focus:border-marigold min-w-0 flex-1 rounded-[6px] border px-2 py-1 text-xs outline-none"
            />
            <button onclick={() => void saveRename()} class="mono text-[11px]" style="color:var(--marigold)">save</button>
          </div>
        {:else}
          <button role="menuitem" onclick={() => { renaming = true; draftName = app.board?.name ?? ''; }} class="hover:bg-inset text-muted-foreground w-full rounded-[7px] px-2.5 py-1.5 text-left text-xs">Rename this board</button>
        {/if}
        <a role="menuitem" href="/b/{app.boardId}/settings" onclick={close} class="hover:bg-inset text-muted-foreground block rounded-[7px] px-2.5 py-1.5 text-xs">Board settings</a>
        <button role="menuitem" onclick={() => void onDelete()} class="hover:bg-inset text-muted-foreground hover:text-coral w-full rounded-[7px] px-2.5 py-1.5 text-left text-xs">Delete this board…</button>
      </div>
    </div>
  {/if}
</div>

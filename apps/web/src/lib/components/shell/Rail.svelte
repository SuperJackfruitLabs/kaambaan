<script lang="ts">
  /**
   * The desktop rail: identity, three destinations, and the account.
   *
   * **What it no longer carries, and why.** It used to list every board and every agent. The board
   * list had no behaviour that changed between three boards and three hundred — a local database
   * with 305 test boards rendered all 305 as one unbroken column — so it moved into a searchable
   * switcher in the board header. The agent list moved to Workspace, and its green dot was deleted
   * outright: it meant "this agent has a capability" and read as "online", a liveness kaambaan
   * cannot know since `agents.status` was dropped in migration 0005 for never being written.
   *
   * Below 900px this is not rendered at all; `BottomNav` takes over. One breakpoint, mobile-first,
   * and never paired with `max-[900px]:` — Tailwind's `max-` is exclusive, so the pair leaves
   * exactly 900px matching both.
   */
  import { page } from '$app/state';
  import { app } from '$lib/stores/app.svelte';
  import { logout } from '$lib/api';

  const boardId = $derived(app.boardId);
  /** Plan owns the bare board route and the card route beneath it. */
  const here = $derived(
    page.url.pathname.startsWith('/workspace')
      ? 'workspace'
      : page.url.pathname.includes('/operate')
        ? 'operate'
        : 'plan',
  );

  const destinations = $derived([
    { id: 'plan', label: 'Plan', href: boardId ? `/b/${boardId}` : '/' },
    { id: 'operate', label: 'Operate', href: boardId ? `/b/${boardId}/operate` : '/' },
    { id: 'workspace', label: 'Workspace', href: '/workspace/agents' },
  ]);

  async function onSignOut(): Promise<void> {
    await logout();
    location.reload();
  }
</script>

<nav class="border-border bg-surface hidden w-[84px] shrink-0 flex-col items-center gap-0.5 border-r px-1.5 py-3 min-[900px]:flex" aria-label="Main">
  <a href={boardId ? `/b/${boardId}` : '/'} class="wordmark mb-3 text-center text-[13px] leading-tight" aria-label="Kaambaan home">
    kaam<span style="color:var(--marigold)">→</span><br />baan
  </a>

  {#each destinations as d (d.id)}
    <a
      href={d.href}
      aria-current={here === d.id ? 'page' : undefined}
      class="mono flex w-full flex-col items-center justify-center gap-1 rounded-[9px] py-2.5 text-[10px] transition
             {here === d.id ? 'bg-accent-bg text-marigold' : 'text-muted-foreground hover:text-foreground'}"
      style="min-height:var(--tap)"
    >
      {#if d.id === 'plan'}
        <svg class="size-[19px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></svg>
      {:else if d.id === 'operate'}
        <span class="relative">
          <svg class="size-[19px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 12h4l2.5-6 4 13 2.5-7H21" /></svg>
          <!-- A dot, not a number. A count only says "there is something" once it is non-zero,
               which is the whole complaint against the "0" badge this replaces. -->
          {#if app.needsYou().length > 0}
            <span class="bg-coral absolute -top-0.5 -right-1 size-[7px] rounded-full" aria-hidden="true"></span>
          {/if}
        </span>
      {:else}
        <svg class="size-[19px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="3" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></svg>
      {/if}
      {d.label}
    </a>
  {/each}

  <div class="mt-auto flex w-full flex-col items-center gap-1">
    <button
      onclick={() => app.toggleTheme()}
      aria-label="Toggle theme"
      aria-pressed={app.theme === 'light'}
      class="text-muted-foreground hover:text-foreground tap rounded-[8px]"
    >{app.theme === 'light' ? '☀' : '☾'}</button>

    {#if app.user}
      <div class="border-border mt-1 flex w-full flex-col items-center gap-1 border-t pt-2">
        {#if app.user.avatarUrl}
          <img src={app.user.avatarUrl} alt="" class="size-6 rounded-full" />
        {:else}
          <span class="bg-inset text-muted-foreground mono grid size-6 place-items-center rounded-full text-[10px]">
            {(app.user.name ?? app.user.login ?? '·').slice(0, 1).toUpperCase()}
          </span>
        {/if}
        <button onclick={() => void onSignOut()} aria-label="Sign out" title="Sign out" class="text-muted-foreground hover:text-coral tap rounded-[8px] text-xs">⏻</button>
      </div>
    {/if}
  </div>
</nav>

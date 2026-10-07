<script lang="ts">
  /**
   * The phone's navigation — the fix for the audit's severe finding.
   *
   * At 390px the old topbar row was 813px wide with `flex-wrap: nowrap` and no scroll, so seven
   * controls were clipped off the page: the view toggle, the filter, spend, notifications, search,
   * and **Agents** — the only door to capabilities, members, tokens and the fleet link. Every
   * management surface built that week did not exist on a phone.
   *
   * Three destinations, each at least 50px tall, which is comfortably past the 44px coarse-pointer
   * floor. Rendered only below 900px; above it the rail takes over.
   *
   * **And the account.** The fourth item is not a destination but a menu: the theme and sign-out.
   * Both lived only in the rail, so below 900px there was no way to sign out at all — the
   * 2026-10-07 responsive audit's one P1. They are in the command palette as well.
   */
  import { page } from '$app/state';
  import { app } from '$lib/stores/app.svelte';
  import { signOut, otherThemeLabel } from './account';

  const boardId = $derived(app.boardId);
  const here = $derived(
    page.url.pathname.startsWith('/workspace')
      ? 'workspace'
      : page.url.pathname.includes('/operate')
        ? 'operate'
        : 'plan',
  );
  const attention = $derived(app.needsYou().length);

  let menuOpen = $state(false);
  let navEl = $state<HTMLElement | null>(null);
  const who = $derived(app.user?.name || app.user?.login || '');
  const initial = $derived((who || '·').slice(0, 1).toUpperCase());

  function onWindowPointer(e: PointerEvent): void {
    if (menuOpen && navEl && !navEl.contains(e.target as Node)) menuOpen = false;
  }
</script>

<svelte:window
  onpointerdown={onWindowPointer}
  onkeydown={(e) => {
    if (menuOpen && e.key === 'Escape') menuOpen = false;
  }}
/>

<nav
  bind:this={navEl}
  class="border-border bg-surface relative grid grid-cols-4 border-t px-2 pt-1 min-[900px]:hidden"
  style="padding-bottom:calc(0.25rem + env(safe-area-inset-bottom, 0px))"
  aria-label="Main"
>
  <a
    href={boardId ? `/b/${boardId}` : '/'}
    aria-current={here === 'plan' ? 'page' : undefined}
    class="mono flex min-h-[50px] flex-col items-center justify-center gap-1 rounded-[9px] text-[10px] {here === 'plan' ? 'text-marigold' : 'text-muted-foreground'}"
  >
    <svg class="size-[19px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></svg>
    Plan
  </a>

  <a
    href={boardId ? `/b/${boardId}/operate` : '/'}
    aria-current={here === 'operate' ? 'page' : undefined}
    class="mono relative flex min-h-[50px] flex-col items-center justify-center gap-1 rounded-[9px] text-[10px] {here === 'operate' ? 'text-marigold' : 'text-muted-foreground'}"
  >
    <svg class="size-[19px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 12h4l2.5-6 4 13 2.5-7H21" /></svg>
    Operate
    {#if attention > 0}
      <span class="bg-coral absolute top-2 left-1/2 ml-1.5 size-[7px] rounded-full" aria-hidden="true"></span>
      <span class="sr-only">{attention} needing attention</span>
    {/if}
  </a>

  <a
    href="/workspace/agents"
    aria-current={here === 'workspace' ? 'page' : undefined}
    class="mono flex min-h-[50px] flex-col items-center justify-center gap-1 rounded-[9px] text-[10px] {here === 'workspace' ? 'text-marigold' : 'text-muted-foreground'}"
  >
    <svg class="size-[19px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="3" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></svg>
    Workspace
  </a>

  <button
    type="button"
    onclick={() => (menuOpen = !menuOpen)}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    aria-controls="account-menu"
    class="mono flex min-h-[50px] flex-col items-center justify-center gap-1 rounded-[9px] text-[10px] {menuOpen ? 'text-marigold' : 'text-muted-foreground'}"
  >
    {#if app.user?.avatarUrl}
      <img src={app.user.avatarUrl} alt="" class="size-[19px] rounded-full" />
    {:else}
      <span class="grid size-[19px] place-items-center rounded-full border border-current text-[10px] leading-none" aria-hidden="true">{initial}</span>
    {/if}
    You
  </button>

  {#if menuOpen}
    <!-- Anchored to the bar's right edge, opening upward: the thumb is already there. -->
    <div
      id="account-menu"
      role="menu"
      aria-label="Account"
      class="bg-surface border-border drawer-in absolute right-2 bottom-[calc(100%+6px)] z-50 w-[min(16rem,calc(100vw-1rem))] overflow-hidden rounded-[12px] border shadow-2xl"
    >
      {#if app.user && who}
        <div class="border-border border-b px-3.5 py-2.5">
          <div class="truncate text-sm font-medium">{who}</div>
          {#if app.user.name && app.user.login}
            <div class="mono text-muted-foreground truncate text-[11px]">{app.user.login}</div>
          {/if}
        </div>
      {/if}
      <button
        type="button"
        role="menuitem"
        onclick={() => {
          app.toggleTheme();
          menuOpen = false;
        }}
        class="hover:bg-inset flex min-h-[48px] w-full items-center gap-3 px-3.5 text-left text-sm"
      >
        <span class="text-muted-foreground w-4 text-center" aria-hidden="true">{app.theme === 'light' ? '☾' : '☀'}</span>
        {otherThemeLabel(app.theme)}
      </button>
      <button
        type="button"
        role="menuitem"
        onclick={() => void signOut()}
        class="hover:bg-inset text-coral border-border flex min-h-[48px] w-full items-center gap-3 border-t px-3.5 text-left text-sm"
      >
        <span class="w-4 text-center" aria-hidden="true">⏻</span>
        Sign out
      </button>
    </div>
  {/if}
</nav>

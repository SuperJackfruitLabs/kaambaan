<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import { logout } from '$lib/api';

  async function signOut(): Promise<void> {
    await logout();
    location.reload();
  }

  /**
   * Escape closes the rail, but only when it is an overlay.
   *
   * At desktop widths the rail is not dismissable, so swallowing Escape there
   * would take the key away from the command palette and the card drawer for
   * no gain.
   */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && app.railOpen) app.closeRail();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!--
  Below `md` the rail is an overlay with a scrim; at `md` and above it is the
  column it has always been. One element serves both, via `max-md:` variants,
  rather than two copies of the same markup that would drift.
-->
{#if app.railOpen}
  <button
    class="fixed inset-0 z-40 bg-black/55 md:hidden"
    onclick={() => app.closeRail()}
    aria-label="Close navigation"
    tabindex="-1"
  ></button>
{/if}

<nav
  class="bg-surface border-border h-screen w-[208px] shrink-0 flex-col border-r
    md:flex
    max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-2xl
    {app.railOpen ? 'max-md:rail-in max-md:flex' : 'max-md:hidden'}"
  aria-label="Main navigation"
>
  <!-- Wordmark -->
  <div class="border-border border-b px-4 py-4">
    <div class="wordmark text-[17px] leading-none">
      kaam<span style="color:var(--marigold)">→</span>baan
    </div>
    <div class="eyebrow mt-1 text-[10px]">agent flight deck</div>
  </div>

  <!-- Nav buttons -->
  <div class="space-y-0.5 px-2 pt-3">
    <button
      onclick={() => app.setScreen('board')}
      class="mono flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-xs transition
        {app.screen === 'board'
          ? 'bg-inset text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-inset/60'}"
    >
      <span class="text-sm leading-none" aria-hidden="true">▦</span>
      Board
    </button>
    <button
      onclick={() => app.setScreen('triage')}
      class="mono flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-xs transition
        {app.screen === 'triage'
          ? 'bg-inset text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-inset/60'}"
    >
      <span class="text-sm leading-none" aria-hidden="true">⊞</span>
      Triage
      {#if app.needsYou().length > 0}
        <span class="ml-auto mono text-[10px]" style="color:var(--coral)">{app.needsYou().length}</span>
      {/if}
    </button>
    <button
      onclick={() => app.setScreen('telemetry')}
      class="mono flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-xs transition
        {app.screen === 'telemetry'
          ? 'bg-inset text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-inset/60'}"
    >
      <span class="text-sm leading-none" aria-hidden="true">◴</span>
      Telemetry
    </button>
  </div>

  <!-- Boards section -->
  <div class="mt-4 px-2">
    <div class="eyebrow px-2 py-1.5 text-[10px]">boards</div>
    <div class="space-y-0.5">
      {#each app.boards as b (b.id)}
        <button
          onclick={() => app.switchBoard(b.id)}
          class="mono flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-xs transition
            {b.id === app.boardId
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-inset/60'}"
        >
          <span
            class="size-1.5 shrink-0 rounded-full"
            style="background:{b.id === app.boardId ? 'var(--marigold)' : 'var(--line)'}"
          ></span>
          <span class="truncate">{b.name}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Agents section -->
  <div class="mt-4 px-2">
    <div class="eyebrow px-2 py-1.5 text-[10px]">agents</div>
    <div class="space-y-0.5">
      {#each app.agents as agent (agent.id)}
        <div class="mono flex items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-xs">
          <span
            class="size-1.5 shrink-0 rounded-full"
            style="background:{agent.capabilities.length > 0 ? 'var(--live)' : 'var(--muted)'}"
          ></span>
          <span class="truncate text-muted-foreground">{agent.name}</span>
        </div>
      {/each}
      {#if app.agents.length === 0}
        <p class="mono px-2.5 py-1 text-[10px]" style="color:var(--muted)">no agents yet</p>
      {/if}
    </div>
  </div>

  <!-- Spacer -->
  <div class="flex-1"></div>

  <!-- Quick-jump + theme -->
  <div class="border-border flex items-center gap-2 border-t px-2 py-2">
    <button
      onclick={() => app.toggleCmdk()}
      class="mono border-border hover:border-marigold/40 flex flex-1 items-center justify-between rounded-[7px] border px-2.5 py-1.5 text-xs"
      style="color:var(--muted)"
    >
      <span>Quick jump</span>
      <span class="text-[10px]">⌘K</span>
    </button>
    <button
      onclick={() => app.toggleTheme()}
      title="Toggle theme"
      aria-label="Toggle theme"
      aria-pressed={app.theme === 'light'}
      class="mono border-border hover:border-marigold/40 shrink-0 rounded-[7px] border px-2.5 py-1.5 text-sm leading-none"
      style="color:var(--muted)"
    >{app.theme === 'light' ? '☀' : '☾'}</button>
  </div>

  <!-- User footer -->
  {#if app.user}
    <div class="border-border flex items-center gap-2 border-t px-3 py-3">
      {#if app.user.avatarUrl}
        <img src={app.user.avatarUrl} alt="" class="size-6 shrink-0 rounded-full" />
      {:else}
        <span
          class="bg-inset mono inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[10px]"
          style="color:var(--muted)"
        >
          {(app.user.name ?? app.user.login ?? '?').slice(0, 1).toUpperCase()}
        </span>
      {/if}
      <span class="mono min-w-0 truncate text-[11px]" style="color:var(--muted)">{app.user.name ?? app.user.login}</span>
      <button
        onclick={() => void signOut()}
        title="Sign out"
        aria-label="Sign out"
        class="mono hover:text-coral ml-auto shrink-0 rounded-[6px] px-1.5 py-1 text-[12px]"
        style="color:var(--muted)"
      >⏻</button>
    </div>
  {/if}
</nav>

<script lang="ts">
  /**
   * Signed in, no board yet. Extracted from `BoardScreen.svelte` unchanged in substance.
   */
  import { goto } from '$app/navigation';
  import { app } from '$lib/stores/app.svelte';
  import { BOARD_TEMPLATES, logout } from '$lib/api';
  import { Button } from '$lib/components/ui/button';

  let creating = $state(false);
  let error = $state<string | null>(null);
  const template = BOARD_TEMPLATES[0]!;

  async function createFirstBoard(): Promise<void> {
    creating = true;
    error = null;
    try {
      const id = await app.createFirstBoard();
      if (id) await goto(`/b/${id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }
</script>

<main class="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 px-5 py-5">
  <div class="flex items-center gap-3">
    <svg class="arrowmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 12h15" /><path d="M13 6l6 6-6 6" /><path d="M3 9l3 3-3 3" />
    </svg>
    <div>
      <div class="flex items-baseline gap-2.5"><span class="wordmark text-[19px] leading-none">Kaambaan</span><span class="eyebrow">agent flight deck</span></div>
      <div class="mono text-muted-foreground mt-1 text-xs">welcome, {app.user?.name ?? app.user?.login ?? 'there'}</div>
    </div>
  </div>

  <div class="bg-surface border-border rounded-[10px] border p-6">
    <div class="eyebrow mb-2">first board</div>
    <h1 class="wordmark text-xl leading-snug">Set up the pipeline your agents will work</h1>
    <p class="text-muted-foreground mt-2.5 text-sm leading-relaxed">
      A board is a pipeline. Work enters as cards and moves stage by stage — agents claim the cards
      they're capable of, do the work, and hand off down the line. An approval gate pauses the flow
      so nothing moves past review without your sign-off.
    </p>
    <div class="mt-4 flex flex-wrap items-center gap-1.5">
      {#each template.stages as s, i (s.key)}
        <span class="border-border mono rounded-[6px] border px-2 py-1 text-[11px] {s.ownerKind === 'capability' ? 'text-marigold' : s.gate === 'approval' ? 'text-coral' : ''}">
          {s.name}{#if s.gate === 'approval'}<span class="ml-1 opacity-70">gate</span>{/if}
        </span>
        {#if i < template.stages.length - 1}<span style="color:var(--marigold)" aria-hidden="true">→</span>{/if}
      {/each}
    </div>
    <div class="mt-6 flex flex-wrap gap-2.5">
      <Button onclick={createFirstBoard} disabled={creating}>{creating ? 'Creating…' : 'Create my first board'}</Button>
      <Button variant="outline" onclick={() => goto('/workspace/agents')}>Connect an agent</Button>
    </div>
  </div>

  <button onclick={() => void logout().then(() => location.reload())} class="text-muted-foreground hover:text-foreground mono self-start text-xs">sign out</button>
  {#if error}<p class="text-coral mono text-xs">{error}</p>{/if}
</main>

<script lang="ts">
  /**
   * The capability registry — and the two counts that make a mismatch visible.
   *
   * A capability held by agents and named by no stage is an agent that can claim nothing: the bug
   * that shipped, where thirteen agents carried `claim` (a token scope) and matched no lane. A
   * capability named by a stage and held by nobody is a lane no one can work. Neither is knowable
   * without counting, which is why the counts are the point rather than decoration.
   */
  import { getCapabilities, createCapability, updateCapability, deleteCapability, type CapabilityRecord } from '$lib/api';
  import { Button } from '$lib/components/ui/button';

  let capabilities = $state<CapabilityRecord[]>([]);
  let newKey = $state('');
  let error = $state<string | null>(null);

  const orphans = $derived(capabilities.filter((c) => c.boardCount === 0 && c.agentCount > 0));
  const unstaffed = $derived(capabilities.filter((c) => c.agentCount === 0 && c.boardCount > 0));

  async function refresh(): Promise<void> {
    capabilities = await getCapabilities();
  }
  $effect(() => { void refresh(); });

  async function add(): Promise<void> {
    const key = newKey.trim();
    if (key === '') return;
    error = null;
    const res = await createCapability({ key });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      error = body?.error ?? `Adding failed (${res.status})`;
      return;
    }
    newKey = '';
    await refresh();
  }

  async function describe(c: CapabilityRecord, description: string): Promise<void> {
    error = null;
    await updateCapability(c.id, { description });
    await refresh();
  }

  async function remove(c: CapabilityRecord): Promise<void> {
    error = null;
    const res = await deleteCapability(c.id);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      error = body?.error ?? `Removing failed (${res.status})`;
    }
    await refresh();
  }
</script>

{#if orphans.length > 0}
  <p class="border-coral/40 text-coral mb-3 rounded-[9px] border px-3 py-2 text-xs leading-relaxed" style="background:color-mix(in srgb, var(--coral) 8%, transparent)">
    <b>{orphans.map((c) => c.key).join(', ')}</b> — held by agents, asked for by no board stage. An
    agent holding only these can claim nothing.
  </p>
{/if}
{#if unstaffed.length > 0}
  <p class="text-muted-foreground mb-3 text-xs leading-relaxed">
    <b>{unstaffed.map((c) => c.key).join(', ')}</b> — asked for by a stage, held by no agent. Those
    lanes will hold cards nothing can claim.
  </p>
{/if}

<div class="space-y-2">
  {#each capabilities as c (c.id)}
    <div class="bg-surface border-border rounded-[10px] border px-3 py-2.5">
      <div class="flex items-center gap-2">
        <span class="mono min-w-0 flex-1 truncate text-sm">{c.key}</span>
        <span class="mono text-muted-foreground shrink-0 text-[11px]" title="{c.agentCount} agent(s) hold this · {c.boardCount} board(s) ask for it">
          {c.agentCount} agent{c.agentCount === 1 ? '' : 's'} ·
          <span style="color:{c.boardCount === 0 ? 'var(--coral)' : 'inherit'}">{c.boardCount} board{c.boardCount === 1 ? '' : 's'}</span>
        </span>
        {#if c.origin === 'inferred'}
          <span class="border-border text-muted-foreground shrink-0 rounded-[4px] border px-1 text-[9px]" title="Nobody defined this — it turned up in use">inferred</span>
        {/if}
        <button onclick={() => void remove(c)} aria-label="Remove capability {c.key}" class="text-muted-foreground hover:text-coral tap shrink-0 rounded-[6px]">
          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <input
        value={c.description ?? ''}
        onblur={(e) => { const v = e.currentTarget.value; if (v !== (c.description ?? '')) void describe(c, v); }}
        placeholder="what does this capability mean?"
        aria-label="Description for {c.key}"
        class="bg-inset border-border focus:border-marigold mt-1.5 w-full rounded-[6px] border px-2 py-1 text-[11px]"
      />
    </div>
  {/each}

  {#if capabilities.length === 0}
    <p class="text-muted-foreground text-sm">
      Nothing yet. A board stage with an agent owner adds one, or name one below.
    </p>
  {/if}
</div>

<div class="mt-4 flex gap-2">
  <input
    bind:value={newKey}
    placeholder="add a capability"
    aria-label="New capability"
    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
    class="bg-inset border-border focus:border-marigold mono min-w-0 flex-1 rounded-[8px] border px-3 py-2 text-xs"
  />
  <Button variant="outline" onclick={() => void add()} disabled={newKey.trim() === ''}>Add</Button>
</div>

{#if error}<p class="text-coral mt-3 text-xs leading-relaxed">{error}</p>{/if}

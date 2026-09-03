<script lang="ts">
  /**
   * The capability registry — and the two counts that make a mismatch visible.
   *
   * A capability held by agents and named by no stage is an agent that can claim nothing: the bug
   * that shipped, where thirteen agents carried `claim` (a token scope) and matched no lane. A
   * capability named by a stage and held by nobody is a lane no one can work. Neither is knowable
   * without counting, which is why the counts are the point rather than decoration.
   */
  import {
    getCapabilities,
    createCapability,
    updateCapability,
    deleteCapability,
    addImplication,
    removeImplication,
    type CapabilityRecord,
  } from '$lib/api';
  import { Button } from '$lib/components/ui/button';

  let capabilities = $state<CapabilityRecord[]>([]);
  let newKey = $state('');
  let error = $state<string | null>(null);
  /** Existing keys the one just added looks like. A hint from the server, never a refusal. */
  let similar = $state<string[]>([]);
  /** Which capability's "implies" row is open. One at a time; this is a rare act. */
  let implyingFor = $state<string | null>(null);
  let implyTo = $state('');

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
    similar = [];
    const res = await createCapability({ key });
    const body = (await res.json().catch(() => null)) as { error?: string; similar?: string[] } | null;
    if (!res.ok) {
      error = body?.error ?? `Adding failed (${res.status})`;
      return;
    }
    // Named, not refused: only a person knows whether `cdoe` was a typo for `code` or a word they
    // meant. Refusing would dead-end a legitimate first move and still miss every existing typo.
    similar = body?.similar ?? [];
    newKey = '';
    await refresh();
  }

  async function imply(from: string): Promise<void> {
    const to = implyTo.trim();
    if (to === '') return;
    error = null;
    const res = await addImplication(from, to);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      error = body?.error ?? `Could not record that (${res.status})`;
      return;
    }
    implyTo = '';
    implyingFor = null;
    await refresh();
  }

  async function unimply(from: string, to: string): Promise<void> {
    error = null;
    await removeImplication(from, to);
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

      <!--
        Implication. Routing stays exact string equality; this is how a workspace says one
        capability is a kind of another without making the match fuzzy. An agent holding this key
        can claim lanes asking for anything listed here.
      -->
      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span class="text-muted-foreground mono text-[10px]">implies</span>
        {#each c.implies ?? [] as to (to)}
          <span class="bg-inset border-border mono inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[10px]">
            {to}
            <button
              onclick={() => void unimply(c.key, to)}
              aria-label="Stop {c.key} implying {to}"
              class="text-muted-foreground hover:text-coral"
            >×</button>
          </span>
        {/each}
        {#if implyingFor === c.key}
          <input
            bind:value={implyTo}
            placeholder="capability"
            aria-label="{c.key} implies"
            onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void imply(c.key); } }}
            onblur={() => { if (implyTo.trim() === '') implyingFor = null; }}
            class="bg-inset border-border focus:border-marigold mono w-28 rounded-[5px] border px-1.5 py-0.5 text-[10px]"
          />
          <button onclick={() => void imply(c.key)} class="text-marigold mono text-[10px]">add</button>
        {:else}
          <button
            onclick={() => { implyingFor = c.key; implyTo = ''; }}
            aria-label="Add what {c.key} implies"
            class="text-muted-foreground hover:text-foreground mono text-[10px]"
          >+</button>
        {/if}
      </div>
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

{#if similar.length > 0}
  <p class="text-muted-foreground mt-2 text-xs leading-relaxed" data-testid="similar-hint">
    This workspace already has <b class="mono">{similar.join(', ')}</b>. If one of those is what you
    meant, remove the new one — routing is exact string equality, so two spellings are two
    capabilities.
  </p>
{/if}

{#if error}<p class="text-coral mt-3 text-xs leading-relaxed">{error}</p>{/if}

<script lang="ts">
  /**
   * The agents, as a list a person can read.
   *
   * Two things changed beyond the move out of the modal. A token id —
   * `tok_f5069d20f96d45a3` — was the most prominent content in a row, machine data in the position
   * the eye lands on first; it is a count now, with the ids behind the row menu. And the sentence
   * about suite principals was repeated verbatim on every unlinked agent, seven times over; it is
   * stated once, above the list.
   */
  import { app } from '$lib/stores/app.svelte';
  import {
    getAgents, getCapabilities, createAgent, updateAgent, deleteAgent,
    issueAgentToken, revokeAgentToken, setAgentPrincipal,
    type AgentSummary, type AgentToken, type CapabilityRecord,
  } from '$lib/api';
  import CapabilityPicker from '$lib/components/CapabilityPicker.svelte';
  import { Button } from '$lib/components/ui/button';

  let agents = $state<AgentSummary[]>([]);
  let capabilities = $state<CapabilityRecord[]>([]);
  let error = $state<string | null>(null);
  let expanded = $state<string | null>(null);

  let editingId = $state<string | null>(null);
  let editName = $state('');
  let editCaps = $state<string[]>([]);
  let editConcurrency = $state(1);
  let editIcon = $state('');
  let saving = $state(false);

  let newName = $state('');
  let newCaps = $state<string[]>([]);
  let minting = $state(false);
  let minted = $state<AgentToken | { agent: { id: string; name: string; capabilities: string[] }; token: string; tokenId: string } | null>(null);

  const anyUnlinked = $derived(agents.some((a) => !a.externalId));

  async function refresh(): Promise<void> {
    [agents, capabilities] = await Promise.all([getAgents().catch(() => []), getCapabilities().catch(() => [])]);
  }
  $effect(() => { void refresh(); });

  function startEdit(a: AgentSummary): void {
    editingId = a.id;
    editName = a.name;
    editCaps = [...a.capabilities];
    editConcurrency = a.concurrency ?? 1;
    editIcon = a.iconUrl ?? '';
    error = null;
  }

  async function saveEdit(): Promise<void> {
    if (!editingId) return;
    saving = true;
    error = null;
    try {
      const res = await updateAgent(editingId, {
        name: editName.trim(),
        capabilities: [...editCaps],
        concurrency: editConcurrency,
        iconUrl: editIcon.trim() === '' ? null : editIcon.trim(),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        error = body?.error ?? `Saving failed (${res.status})`;
        return;
      }
      editingId = null;
      await refresh();
    } finally {
      saving = false;
    }
  }

  async function onDelete(a: AgentSummary): Promise<void> {
    const loses = [
      a.tokenIds.length > 0 ? `${a.tokenIds.length} active token${a.tokenIds.length === 1 ? '' : 's'}` : null,
      a.externalId ? 'its link to a suite principal' : null,
    ].filter(Boolean);
    const detail = loses.length > 0 ? ` This also deletes ${loses.join(' and ')}.` : '';
    if (!confirm(`Delete ${a.name}?${detail} This cannot be undone.`)) return;
    if ((await deleteAgent(a.id)).ok) await refresh();
  }

  async function onIssue(a: AgentSummary): Promise<void> {
    error = null;
    try {
      minted = { agent: { id: a.id, name: a.name, capabilities: a.capabilities }, ...(await issueAgentToken(a.id)) };
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function onRevoke(a: AgentSummary, tokenId: string): Promise<void> {
    if (!confirm('Revoke this token? The agent loses access immediately, and this cannot be undone.')) return;
    if ((await revokeAgentToken(a.id, tokenId)).ok) await refresh();
  }

  async function onUnlink(a: AgentSummary): Promise<void> {
    if ((await setAgentPrincipal(a.id, null)).ok) await refresh();
  }

  async function mint(): Promise<void> {
    if (newName.trim() === '' || newCaps.length === 0) return;
    minting = true;
    error = null;
    try {
      minted = await createAgent(newName.trim(), [...newCaps]);
      newName = '';
      newCaps = [];
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      minting = false;
    }
  }
</script>

{#if minted}
  <div class="border-marigold/40 bg-inset mb-4 rounded-[10px] border p-3.5">
    <p class="text-sm leading-relaxed">
      <span class="font-medium">{minted.agent.name}</span>'s token —
      <span class="text-coral">copy it now, it won't be shown again.</span>
    </p>
    <div class="bg-surface border-border mono mt-2.5 flex items-center justify-between gap-2 rounded-[7px] border px-3 py-2 text-xs">
      <span class="truncate">{minted.token}</span>
      <button onclick={() => navigator.clipboard?.writeText(minted!.token)} class="shrink-0" style="color:var(--marigold);min-height:var(--tap)">copy</button>
    </div>
    <div class="mt-3 flex justify-end"><Button onclick={() => (minted = null)}>Done</Button></div>
  </div>
{/if}

{#if anyUnlinked}
  <!-- Said once. It used to be repeated verbatim on every unlinked row. -->
  <p class="text-muted-foreground mb-3 text-xs leading-relaxed">
    An agent linked to a suite principal also accepts the tokens AgentPod issues for it. Unlinked is
    the ordinary state for a standalone board — link one from <a href="/workspace/connections" class="underline underline-offset-2">Connections</a>.
  </p>
{/if}

<div class="space-y-2">
  {#each agents as a (a.id)}
    <div class="bg-surface border-border rounded-[10px] border px-3 py-2.5">
      {#if editingId === a.id}
        <input bind:value={editName} aria-label="Agent name" class="bg-inset border-border focus:border-marigold w-full rounded-[7px] border px-2.5 py-1.5 text-sm" />
        <div class="text-muted-foreground mt-2 mb-1 text-[11px]">capabilities it can claim:</div>
        <CapabilityPicker bind:selected={editCaps} registry={capabilities} id="edit-{a.id}" />
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">cards at once
            <input type="number" min="1" bind:value={editConcurrency} class="bg-inset border-border focus:border-marigold w-14 rounded-[6px] border px-1.5 py-1" /></label>
          <input bind:value={editIcon} placeholder="https://… avatar" aria-label="Avatar URL" class="bg-inset border-border focus:border-marigold mono min-w-0 flex-1 rounded-[6px] border px-2 py-1 text-[10px]" />
          <button onclick={() => void saveEdit()} disabled={saving || editName.trim() === ''} class="mono text-[11px]" style="color:var(--marigold);min-height:var(--tap)">{saving ? 'saving…' : 'save'}</button>
          <button onclick={() => (editingId = null)} class="text-muted-foreground mono text-[11px]" style="min-height:var(--tap)">cancel</button>
        </div>
      {:else}
        <div class="flex flex-wrap items-center gap-2">
          {#if a.iconUrl}
            <img src={a.iconUrl} alt="" class="size-6 shrink-0 rounded-full object-cover" />
          {/if}
          <span class="min-w-[7rem] text-sm font-medium">{a.name}</span>
          {#each a.capabilities as c (c)}
            <span class="border-border mono text-muted-foreground rounded-[5px] border px-1.5 py-0.5 text-[10px]">{c}</span>
          {/each}
          {#if a.capabilities.length === 0}
            <span class="text-coral text-[11px]">no capabilities — this agent can claim nothing</span>
          {/if}

          <span class="mono text-muted-foreground ml-auto flex shrink-0 items-center gap-2.5 text-[11px]">
            {#if a.externalId}<span style="color:var(--live)">● linked</span>{/if}
            <span>{a.tokenIds.length} token{a.tokenIds.length === 1 ? '' : 's'}</span>
            <button onclick={() => (expanded = expanded === a.id ? null : a.id)} aria-label="More actions for {a.name}" aria-expanded={expanded === a.id} class="tap hover:text-foreground rounded-[6px]">⋯</button>
          </span>
        </div>

        {#if expanded === a.id}
          <div class="border-border mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
            <button onclick={() => startEdit(a)} class="border-border hover:border-marigold rounded-[7px] border px-2.5 text-[11px]" style="min-height:var(--tap)">Edit</button>
            <button onclick={() => void onIssue(a)} class="border-border hover:border-marigold rounded-[7px] border px-2.5 text-[11px]" style="min-height:var(--tap)">Issue a token</button>
            {#if a.externalId}
              <button onclick={() => void onUnlink(a)} class="border-border hover:border-marigold rounded-[7px] border px-2.5 text-[11px]" style="min-height:var(--tap)">Unlink principal</button>
            {/if}
            <button onclick={() => void onDelete(a)} class="border-border hover:border-coral hover:text-coral rounded-[7px] border px-2.5 text-[11px]" style="min-height:var(--tap)">Delete</button>
            {#each a.tokenIds as t (t)}
              <span class="border-border mono text-muted-foreground inline-flex items-center gap-1 rounded-[5px] border px-1.5 text-[10px]">
                {t}
                <button onclick={() => void onRevoke(a, t)} aria-label="Revoke token {t}" class="tap hover:text-coral rounded-[4px]">×</button>
              </span>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/each}

  {#if agents.length === 0}
    <p class="text-muted-foreground text-sm">No agents yet. Create one below — you'll get a token to point an AI agent at this workspace.</p>
  {/if}
</div>

<div class="border-border mt-5 border-t pt-4">
  <div class="eyebrow mb-2">new agent</div>
  <input bind:value={newName} placeholder="e.g. research-ray" aria-label="New agent name" class="bg-inset border-border focus:border-marigold w-full rounded-[8px] border px-3 py-2 text-sm" />
  <div class="text-muted-foreground mt-2.5 mb-1.5 text-xs">capabilities it can claim:</div>
  <CapabilityPicker bind:selected={newCaps} registry={capabilities} id="new-agent" />
  <div class="mt-3 flex justify-end">
    <Button onclick={mint} disabled={minting || newName.trim() === '' || newCaps.length === 0}>{minting ? 'Creating…' : 'Create + mint token'}</Button>
  </div>
</div>

{#if error}<p class="text-coral mt-3 text-xs leading-relaxed">{error}</p>{/if}

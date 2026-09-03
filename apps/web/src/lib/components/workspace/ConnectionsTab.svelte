<script lang="ts">
  /**
   * Where this workspace is also known.
   *
   * The fleet link comes first and the agent picker second, because that is the order the two acts
   * have to happen in: linking an agent to a principal resolves nothing while the fleet that
   * principal belongs to is unlinked — `resolveHubAgent` maps the claim's tenant through this row
   * and refuses when it is missing.
   */
  import { app } from '$lib/stores/app.svelte';
  import {
    getWorkspace, setWorkspaceFleet, getHubPrincipals, getAgents, getCapabilities, createAgent,
    type WorkspaceTenant, type HubPrincipal, type AgentSummary, type CapabilityRecord,
  } from '$lib/api';
  import { beginHubAuthorization, hubStatus } from '$lib/hub-token';
  import CapabilityPicker from '$lib/components/CapabilityPicker.svelte';
  import { Button } from '$lib/components/ui/button';

  let workspace = $state<WorkspaceTenant | null>(null);
  let agents = $state<AgentSummary[]>([]);
  let capabilities = $state<CapabilityRecord[]>([]);
  let editingFleet = $state(false);
  let fleetInput = $state('');
  let error = $state<string | null>(null);
  let saving = $state(false);

  let hubConfigured = $state(false);
  let principals = $state<HubPrincipal[] | null>(null);
  let connecting = $state(false);
  let picked = $state<string[]>([]);
  let importCaps = $state<string[]>([]);
  let importing = $state(false);
  let importResult = $state<string | null>(null);

  const linkable = $derived(
    (principals ?? []).filter((p) => !agents.some((a) => a.externalId === p.id)),
  );

  async function refresh(): Promise<void> {
    [workspace, agents, capabilities] = await Promise.all([
      getWorkspace().catch(() => null),
      getAgents().catch(() => []),
      getCapabilities().catch(() => []),
    ]);
    const status = await hubStatus().catch(() => ({ configured: false }));
    hubConfigured = status.configured;
    if (hubConfigured) principals = await getHubPrincipals().catch(() => null);
  }
  $effect(() => { void refresh(); });

  async function saveFleet(): Promise<void> {
    saving = true;
    error = null;
    try {
      const v = fleetInput.trim();
      const res = await setWorkspaceFleet(v === '' ? null : v);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        error = body?.error ?? `Linking failed (${res.status})`;
        return;
      }
      editingFleet = false;
      await refresh();
    } finally {
      saving = false;
    }
  }

  async function connect(): Promise<void> {
    connecting = true;
    try {
      await beginHubAuthorization();
    } finally {
      connecting = false;
    }
  }

  async function addPicked(): Promise<void> {
    if (picked.length === 0 || importCaps.length === 0) return;
    importing = true;
    importResult = null;
    const failures: string[] = [];
    try {
      for (const id of picked) {
        const p = linkable.find((x) => x.id === id);
        if (!p) continue;
        try {
          // Named by handle, not station key — a board reads like a team, not a config file.
          await createAgent(p.handle, [...importCaps], p.id);
        } catch (e) {
          failures.push(`${p.handle}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      picked = [];
      importResult = failures.length === 0 ? null : failures.join('; ');
      await refresh();
    } finally {
      importing = false;
    }
  }
</script>

<section class="bg-surface border-border rounded-[10px] border px-3 py-2.5">
  <div class="eyebrow mb-1.5">agentpod fleet</div>
  {#if editingFleet}
    <div class="flex flex-wrap items-center gap-2">
      <input bind:value={fleetInput} placeholder="fleet_…  (empty to unlink)" class="bg-inset border-border focus:border-marigold mono min-w-0 flex-1 rounded-[6px] border px-2 py-1 text-[11px]" />
      <button onclick={() => void saveFleet()} disabled={saving} class="mono text-[11px]" style="color:var(--marigold);min-height:var(--tap)">save</button>
      <button onclick={() => (editingFleet = false)} class="text-muted-foreground mono text-[11px]" style="min-height:var(--tap)">cancel</button>
    </div>
  {:else if workspace?.externalId}
    <div class="mono flex items-center gap-2 text-[11px]">
      <span class="truncate">{workspace.externalId}</span>
      <button onclick={() => { editingFleet = true; fleetInput = workspace?.externalId ?? ''; }} class="text-muted-foreground hover:text-foreground ml-auto" style="min-height:var(--tap)">change</button>
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-2">
      <p class="text-muted-foreground min-w-0 flex-1 text-[11px] leading-relaxed">
        Not linked to an AgentPod fleet — link one so the tokens its hub issues are accepted here.
      </p>
      <button onclick={() => { editingFleet = true; fleetInput = ''; }} class="mono text-[11px]" style="color:var(--marigold);min-height:var(--tap)">link</button>
    </div>
  {/if}
</section>

{#if hubConfigured}
  <section class="mt-3">
    {#if principals === null}
      <Button variant="outline" onclick={connect} disabled={connecting} data-testid="connect-hub">
        {connecting ? 'Connecting…' : 'Connect to AgentPod'}
      </Button>
    {:else if linkable.length === 0}
      <p class="text-muted-foreground text-xs">Every agent in the fleet already has one here.</p>
    {:else}
      <div class="eyebrow mb-2">add from agentpod</div>
      <div class="flex flex-wrap gap-1.5" data-testid="hub-principal-list">
        {#each linkable as p (p.id)}
          <button
            onclick={() => (picked = picked.includes(p.id) ? picked.filter((x) => x !== p.id) : [...picked, p.id])}
            title={p.id}
            class="mono rounded-[6px] border px-2.5 text-[11px] {picked.includes(p.id) ? 'border-marigold text-marigold' : 'border-border text-muted-foreground hover:text-foreground'}"
            style="min-height:var(--tap)"
          >{picked.includes(p.id) ? '✓ ' : ''}{p.handle}</button>
        {/each}
      </div>
      <div class="text-muted-foreground mt-2.5 mb-1.5 text-xs">capabilities they can claim:</div>
      <CapabilityPicker bind:selected={importCaps} registry={capabilities} id="import" />
      {#if importResult}<p class="text-coral mt-2 text-xs" data-testid="import-failures">{importResult}</p>{/if}
      <div class="mt-3 flex justify-end">
        <Button onclick={addPicked} disabled={importing || picked.length === 0 || importCaps.length === 0} data-testid="add-picked-agents">
          {importing ? 'Adding…' : `Add ${picked.length || ''}`.trim()}
        </Button>
      </div>
    {/if}
  </section>
{/if}

{#if error}<p class="text-coral mt-3 text-xs leading-relaxed">{error}</p>{/if}

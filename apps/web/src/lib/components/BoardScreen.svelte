<script lang="ts">
  import { onMount } from 'svelte';
  import {
    logout,
    createAgent,
    getHubPrincipals,
    type HubPrincipal,
    getAgents,
    deleteAgent,
    setAgentPrincipal,
    getWorkspace,
    setWorkspaceFleet,
    type WorkspaceTenant,
    revokeAgentToken,
    updateAgent,
    issueAgentToken,
    getMembers,
    addMember,
    setMemberRole,
    removeMember,
    type Member,
    type Role,
    BOARD_TEMPLATES,
    type AgentToken,
    type AgentSummary,
  } from '$lib/api';
  import { beginHubAuthorization, hubStatus } from '$lib/hub-token';
  import { Button } from '$lib/components/ui/button';
  import NewBoardDialog from '$lib/components/NewBoardDialog.svelte';
  import BoardSettings from '$lib/components/BoardSettings.svelte';
  import CapabilityPicker from '$lib/components/CapabilityPicker.svelte';
  import BoardKanban from '$lib/components/board/BoardKanban.svelte';
  import ListView from '$lib/components/board/ListView.svelte';
  import CardDrawer from '$lib/components/CardDrawer.svelte';
  import Rail from '$lib/components/Rail.svelte';
  import Topbar from '$lib/components/Topbar.svelte';
  import TriageInbox from '$lib/components/TriageInbox.svelte';
  import Telemetry from '$lib/components/Telemetry.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { replaceState } from '$app/navigation';

  /**
   * The board and card named by the URL, if any.
   *
   * Extracted out of `routes/+page.svelte` so `/`, `/b/[boardId]` and
   * `/b/[boardId]/c/[cardId]` all render one screen rather than three copies
   * of it — the board is a single app, and the routes only differ in what
   * they open it on.
   */
  let {
    routeBoardId = null,
    routeCardId = null,
  }: { routeBoardId?: string | null; routeCardId?: string | null } = $props();

  // ---- store aliases ----
  const board = $derived(app.board);
  const authState = $derived(app.authState);
  const user = $derived(app.user);
  const needsBoard = $derived(app.needsBoard);

  // ---- page-local UI state ----
  let creating = $state(false);
  let error = $state<string | null>(null);

  // modals
  let showNewBoard = $state(false);
  let showSettings = $state(false);

  // agents manager
  let showConnect = $state(false);
  let agents = $state<AgentSummary[]>([]);
  /**
   * The capabilities this board can actually staff.
   *
   * Was a hardcoded `['research','review','publish']` while the shipped templates define stages
   * needing `code`, `test`, `deploy`, `triage` — so an agent could never be staffed to most of
   * the templates the product ships with. A stage's `owner` slug is the only value
   * `stageMatches` compares against, so it is the only honest source for this list.
   */
  const boardCaps = $derived(
    [...new Set((board?.stages ?? []).filter((s) => s.ownerKind === 'capability' && s.owner).map((s) => s.owner!))].sort(),
  );
  let agentName = $state('');
  let newCaps = $state<string[]>([]);

  // editing an existing agent, one at a time
  let editingAgentId = $state<string | null>(null);
  let editName = $state('');
  let editCaps = $state<string[]>([]);
  let editConcurrency = $state(1);
  let editIconUrl = $state('');
  let editError = $state<string | null>(null);
  let savingEdit = $state(false);

  // issuing a replacement token, one agent at a time
  let issuingFor = $state<string | null>(null);

  // ---- people ----
  //
  // A workspace was permanently one person: `memberships.role` was written once as 'owner' and
  // read by nothing, and there was no invite, no member list and no role change. This panel is
  // the whole human authorization model made visible — which matters because it is now enforced,
  // so a member who cannot do something needs to see who to ask.
  let members = $state<Member[]>([]);
  let inviteEmail = $state('');
  let inviteRole = $state<Role>('member');
  let membersError = $state<string | null>(null);
  let membersBusy = $state(false);

  const ROLE_HELP: Record<Role, string> = {
    viewer: 'reads the board',
    member: 'works the board — cards, gates, questions',
    admin: 'also manages boards and agents',
    owner: 'also manages people and the fleet link',
  };

  async function refreshMembers(): Promise<void> {
    members = await getMembers();
  }

  async function onInvite(): Promise<void> {
    const email = inviteEmail.trim();
    if (email === '') return;
    membersBusy = true;
    membersError = null;
    try {
      const res = await addMember(email, inviteRole);
      if (!res.ok) {
        // The server's own sentence — "a valid email address is required" — names the mistake.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        membersError = body?.error ?? `Inviting failed (${res.status})`;
        return;
      }
      inviteEmail = '';
      await refreshMembers();
    } finally {
      membersBusy = false;
    }
  }

  async function onRoleChange(m: Member, role: Role): Promise<void> {
    membersError = null;
    const res = await setMemberRole(m.userId, role);
    if (!res.ok) {
      // Includes the refusal to leave a workspace with no owner, which is the one an operator
      // most needs to read rather than guess at.
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      membersError = body?.error ?? `Changing that role failed (${res.status})`;
    }
    await refreshMembers();
  }

  async function onRemoveMember(m: Member): Promise<void> {
    if (!confirm(`Remove ${m.email} from this workspace? They lose access on their next request.`)) return;
    membersError = null;
    const res = await removeMember(m.userId);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      membersError = body?.error ?? `Removing them failed (${res.status})`;
    }
    await refreshMembers();
  }
  let minted = $state<AgentToken | null>(null);
  let minting = $state(false);

  // linking THIS WORKSPACE to a hub fleet — the row both hub-token resolvers require
  let workspace = $state<WorkspaceTenant | null>(null);
  let fleetInput = $state('');
  let fleetError = $state<string | null>(null);
  let fleetSaving = $state(false);
  let editingFleet = $state(false);

  // linking a suite principal, one agent's input open at a time
  let linkingAgentId = $state<string | null>(null);
  let principalInput = $state('');
  let principalError = $state<string | null>(null);
  let linking = $state(false);

  // revoking a token, one confirmation-in-flight at a time
  let revokingTokenId = $state<string | null>(null);

  const mcpSnippet = $derived(
    minted
      ? JSON.stringify({ mcpServers: { kaambaan: { url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${minted.token}` } } } }, null, 2)
      : '',
  );

  // ---- lifecycle ----
  onMount(() => {
    void app.init({ boardId: routeBoardId, cardId: routeCardId }).then(() => {
      agents = app.agents;
    });
    return () => app.dispose();
  });

  /**
   * Keep the address bar honest.
   *
   * Without this half, a link works when followed and starts lying the moment
   * the reader clicks anything — which is worse than no routing at all,
   * because the URL now looks authoritative.
   *
   * `replaceState` rather than `goto`: switching board or opening a card is
   * not a navigation a reader expects Back to undo one step at a time. Back
   * should leave the board, not walk through every card they glanced at.
   */
  $effect(() => {
    const boardId = app.boardId;
    if (!boardId) return;
    const cardId = app.openCardId;
    const next = cardId ? `/b/${boardId}/c/${cardId}` : `/b/${boardId}`;
    if (location.pathname !== next) replaceState(next, {});
  });

  /**
   * The command palette's Agents row lands here.
   *
   * The palette is a sibling of this screen and cannot open a panel this component owns, so it
   * raises a request and this answers it. Cleared immediately, so the same row selected twice is
   * two requests rather than one that latches.
   */
  $effect(() => {
    if (app.agentsPanelFor === null) return;
    app.agentsPanelFor = null;
    void openAgents();
  });

  // ---- onboarding / first board ----
  async function createFirstBoard(): Promise<void> {
    creating = true;
    try {
      await app.createFirstBoard();
      if (app.error) error = app.error;
      agents = app.agents;
    } finally {
      creating = false;
    }
  }

  async function onLogout(): Promise<void> {
    await logout();
    location.reload();
  }

  // ---- agents ----
  async function openAgents(): Promise<void> {
    showConnect = true;
    minted = null;
    editingFleet = false;
    fleetError = null;
    try {
      agents = await getAgents();
    } catch {
      agents = [];
    }
    // The workspace's own fleet link, read alongside the agents it gates.
    await refreshWorkspace().catch(() => {});
    await refreshMembers().catch(() => {});
    // Asked when the panel opens rather than on a click, because the answer
    // decides whether there is anything to click.
    await refreshHubSection().catch(() => {});
  }

  async function mintAgent(): Promise<void> {
    if (agentName.trim() === '' || newCaps.length === 0) return;
    minting = true;
    try {
      minted = await createAgent(agentName.trim(), [...newCaps]);
      agentName = '';
      agents = await getAgents();
    } catch (e) {
      error = String(e);
    } finally {
      minting = false;
    }
  }

  // ---- adding agents that already exist in the suite -----------------------
  //
  // Doing this by hand was four steps per agent: create (which hands back a
  // `kbn_` secret a linked agent never uses), copy the `agt_` id, go and find
  // the `prn_` in the other plane, then link. This asks the hub who its agents
  // are and does the rest.
  //
  // Three states, and they are not the same state:
  //
  //   no hub at all      → the whole block does not render, and nothing here
  //                        ever navigates. A kaambaan with no hub is not a
  //                        broken kaambaan (migration 0003), so it must not be
  //                        shown a button leading to a hub that is not there.
  //   hub, no authority  → "Connect to AgentPod", which is the only thing on
  //                        this screen that leaves the origin, and only ever
  //                        because someone clicked it.
  //   hub and authority  → the picker.
  //
  // `hubConfigured` has to come from our own back end because `HUB_ISSUER` is
  // the Worker's environment, not the page's — a null token cannot tell the
  // first state from the second.
  let hubConfigured = $state(false);
  let hubPrincipals = $state<HubPrincipal[] | null>(null);
  let connecting = $state(false);
  let picked = $state<string[]>([]);
  // Empty, and the Add button stays disabled until the operator picks. This defaulted to
  // `['claim']` — a token SCOPE, not a capability — so every agent added through the picker got a
  // capability no stage has ever named, and could claim nothing at all on any board.
  let importCaps = $state<string[]>([]);
  let importing = $state(false);
  let importResult = $state<string | null>(null);

  /**
   * What this deployment's hub will tell us, if it has one.
   *
   * `null` principals with a hub configured is not an error to show: an
   * expired token, a hub that is down and an operator who never connected all
   * land here, and "Connect to AgentPod" is the right and only next move for
   * every one of them.
   */
  async function refreshHubSection(): Promise<void> {
    const status = await hubStatus();
    hubConfigured = status.configured;
    hubPrincipals = status.token ? await getHubPrincipals() : null;
  }

  /**
   * Send the operator to the hub. The one navigation on this screen.
   *
   * `beginHubAuthorization` answers `false` — not an error — for a deployment
   * with no hub, and navigates nowhere in that case. The button is not rendered
   * then either, so this is belt and braces rather than the only guard.
   */
  async function connectToHub(): Promise<void> {
    connecting = true;
    if (!(await beginHubAuthorization())) connecting = false;
  }

  /** Agents with no counterpart here yet — the ones worth offering. */
  const linkable = $derived(
    (hubPrincipals ?? []).filter((p) => !agents.some((a) => a.externalId === p.id)),
  );

  function togglePicked(id: string): void {
    picked = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
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
          // One call each rather than a bulk endpoint: a partial failure then
          // names the agent it happened to, and the ones that worked stay.
          await createAgent(p.displayName ?? p.handle, [...importCaps], p.id);
        } catch (e) {
          failures.push(`${p.handle}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      agents = await getAgents();
      picked = [];
      importResult = failures.length === 0 ? null : failures.join('; ');
    } finally {
      importing = false;
    }
  }

  async function onDeleteAgent(agent: AgentSummary): Promise<void> {
    // Hard delete, no archive and no undo — the agent, every token it holds, and its principal
    // link all go at once. A confirm() names what is lost rather than letting one stray click on
    // a hover-revealed × do it silently.
    const loses = [
      agent.tokenIds.length > 0 ? `${agent.tokenIds.length} active token${agent.tokenIds.length === 1 ? '' : 's'}` : null,
      agent.externalId ? 'its link to a suite principal' : null,
    ].filter(Boolean);
    const detail = loses.length > 0 ? ` This also deletes ${loses.join(' and ')}.` : '';
    if (!confirm(`Delete ${agent.name}?${detail} This cannot be undone.`)) return;
    const res = await deleteAgent(agent.id);
    if (res.ok) agents = await getAgents();
  }

  // ---- link this workspace to a hub fleet ----
  //
  // Deliberately in the same panel as the per-agent principal control, because linking an agent
  // to a principal does nothing at all while the fleet that principal belongs to is unlinked:
  // `resolveHubAgent` maps the claim's tenant through this row and refuses when it is missing.
  // Two controls, one act, and the order matters — so they are next to each other.
  async function refreshWorkspace(): Promise<void> {
    workspace = await getWorkspace();
  }

  function startFleetEdit(): void {
    editingFleet = true;
    fleetInput = workspace?.externalId ?? '';
    fleetError = null;
  }

  async function saveFleet(): Promise<void> {
    const value = fleetInput.trim();
    fleetSaving = true;
    fleetError = null;
    try {
      const res = await setWorkspaceFleet(value === '' ? null : value);
      if (!res.ok) {
        // The server's own sentence — "externalId must look like fleet_ …" — not a generic
        // failure, same as the principal control below.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        fleetError = body?.error ?? `Linking failed (${res.status})`;
        return;
      }
      await refreshWorkspace();
      editingFleet = false;
    } finally {
      fleetSaving = false;
    }
  }

  // ---- link a suite principal ----
  function startLinking(agent: AgentSummary): void {
    linkingAgentId = agent.id;
    principalInput = agent.externalId ?? '';
    principalError = null;
  }

  function cancelLinking(): void {
    linkingAgentId = null;
    principalInput = '';
    principalError = null;
  }

  async function saveLinking(): Promise<void> {
    if (!linkingAgentId) return;
    const value = principalInput.trim();
    linking = true;
    principalError = null;
    try {
      const res = await setAgentPrincipal(linkingAgentId, value === '' ? null : value);
      if (!res.ok) {
        // The server's own refusal (a malformed id, or an agent this session doesn't own) —
        // not a generic "failed" message.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        principalError = body?.error ?? `Linking failed (${res.status})`;
        return;
      }
      agents = await getAgents();
      linkingAgentId = null;
      principalInput = '';
    } finally {
      linking = false;
    }
  }

  async function unlinkPrincipal(agent: AgentSummary): Promise<void> {
    const res = await setAgentPrincipal(agent.id, null);
    if (res.ok) agents = await getAgents();
  }

  // ---- edit an agent ----
  //
  // Capabilities were fixed at creation until the API grew a writer: the only way to restaff an
  // agent was to delete it and make another, which for a linked agent discarded its principal
  // link with it.
  function startEditing(agent: AgentSummary): void {
    editingAgentId = agent.id;
    editName = agent.name;
    editCaps = [...agent.capabilities];
    editConcurrency = agent.concurrency ?? 1;
    editIconUrl = agent.iconUrl ?? '';
    editError = null;
  }

  function cancelEditing(): void {
    editingAgentId = null;
    editError = null;
  }

  async function saveEditing(): Promise<void> {
    if (!editingAgentId) return;
    savingEdit = true;
    editError = null;
    try {
      const res = await updateAgent(editingAgentId, {
        name: editName.trim(),
        capabilities: [...editCaps],
        concurrency: editConcurrency,
        // '' clears it. The server takes null for that and refuses anything that is not https,
        // because this renders as an <img> src on a card tile.
        iconUrl: editIconUrl.trim() === '' ? null : editIconUrl.trim(),
      });
      if (!res.ok) {
        // The server's own sentence, which names the field that was wrong.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        editError = body?.error ?? `Saving failed (${res.status})`;
        return;
      }
      agents = await getAgents();
      editingAgentId = null;
    } finally {
      savingEdit = false;
    }
  }

  // ---- issue a replacement token ----
  //
  // The other half of revocation. The panel has always said a tokenless agent "cannot
  // authenticate until reconnected"; this is the reconnect.
  async function onIssueToken(agent: AgentSummary): Promise<void> {
    issuingFor = agent.id;
    try {
      const fresh = await issueAgentToken(agent.id);
      // Shown through the same one-time reveal the create flow uses, so an operator meets the
      // "copy it now" warning in exactly one place rather than two that look different.
      minted = { agent: { id: agent.id, name: agent.name, capabilities: agent.capabilities }, ...fresh };
      agents = await getAgents();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      issuingFor = null;
    }
  }

  // ---- revoke a token ----
  async function onRevokeToken(agentId: string, tokenId: string): Promise<void> {
    // Immediate and irreversible: the very next request carrying it is refused. A confirm() names
    // the consequence rather than letting a stray click do it silently.
    if (!confirm('Revoke this token? The agent loses access immediately, and this cannot be undone.')) return;
    revokingTokenId = tokenId;
    try {
      const res = await revokeAgentToken(agentId, tokenId);
      if (res.ok) agents = await getAgents();
    } finally {
      revokingTokenId = null;
    }
  }

  function closeConnect(): void {
    showConnect = false;
    minted = null;
    agentName = '';
    cancelLinking();
  }

  // ---- board created callback ----
  async function onBoardCreated(id: string): Promise<void> {
    showNewBoard = false;
    await app.openBoard(id);
    agents = app.agents;
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      app.closeCard();
      closeConnect();
      showNewBoard = false;
      showSettings = false;
    }
  }}
/>

<main class="min-h-screen">
  {#if authState === 'loading'}
    <div class="flex min-h-[70vh] flex-col items-center justify-center gap-3 text-center">
      <svg class="arrowmark size-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 12h15" /><path d="M13 6l6 6-6 6" /><path d="M3 9l3 3-3 3" />
      </svg>
      <div class="wordmark text-lg">Kaambaan</div>
      <div class="mono text-muted-foreground flex items-center gap-2 text-xs"><span class="live-dot"></span>warming up the flight deck…</div>
    </div>
  {:else if authState === 'signed-out'}
    <!-- sign-in -->
    <div class="mx-auto flex min-h-[85vh] max-w-md flex-col items-center justify-center gap-7 text-center px-5 py-5">
      <div class="flex flex-col items-center gap-3">
        <svg class="arrowmark size-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12h15" /><path d="M13 6l6 6-6 6" /><path d="M3 9l3 3-3 3" />
        </svg>
        <div class="flex items-baseline gap-2.5">
          <span class="wordmark text-3xl leading-none">Kaambaan</span>
          <span class="eyebrow">agent flight deck</span>
        </div>
      </div>
      <p class="text-muted-foreground max-w-sm text-sm leading-relaxed">
        A board where AI agents do the work and you stay in command. Cards flow through your pipeline, agents pick up the ones they can handle, and nothing ships until you approve it.
      </p>
      <a
        href="/auth/login"
        data-sveltekit-reload
        class="bg-primary text-primary-foreground inline-flex items-center gap-2.5 rounded-[7px] px-4 py-2.5 text-sm font-medium transition hover:brightness-110"
      >
        <svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.21 3.44 9.63 8.2 11.19.6.11.82-.26.82-.58l-.01-2C5.67 21.6 4.97 19.3 4.97 19.3c-.55-1.36-1.34-1.73-1.34-1.73-1.08-.73.09-.72.09-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.8 2.8 1.28 3.49.98.11-.76.42-1.28.76-1.58-2.66-.3-5.47-1.31-5.47-5.83 0-1.29.47-2.34 1.24-3.17-.13-.3-.54-1.5.11-3.12 0 0 1-.32 3.3 1.21a11.5 11.5 0 0 1 6 0c2.3-1.53 3.3-1.21 3.3-1.21.65 1.62.24 2.82.12 3.12.77.83 1.23 1.88 1.23 3.17 0 4.53-2.81 5.53-5.49 5.82.43.37.81 1.1.81 2.22l-.01 3.29c0 .32.22.69.83.57A12 12 0 0 0 24 12.29C24 5.78 18.63.5 12 .5Z" /></svg>
        Sign in with GitHub
      </a>
      {#if error}<p class="text-coral mono text-xs">{error}</p>{/if}
    </div>
  {:else if needsBoard}
    <!-- onboarding: signed in, no board yet -->
    <div class="mx-auto flex min-h-[85vh] max-w-xl flex-col justify-center gap-5 px-5 py-5">
      <div class="flex items-center gap-3">
        <svg class="arrowmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12h15" /><path d="M13 6l6 6-6 6" /><path d="M3 9l3 3-3 3" />
        </svg>
        <div>
          <div class="flex items-baseline gap-2.5"><span class="wordmark text-[19px] leading-none">Kaambaan</span><span class="eyebrow">agent flight deck</span></div>
          <div class="mono text-muted-foreground mt-1 text-xs">welcome, {user?.name ?? user?.login ?? 'there'}</div>
        </div>
      </div>
      <div class="bg-surface border-border rounded-[10px] border p-6">
        <div class="eyebrow mb-2">first board</div>
        <h1 class="wordmark text-xl leading-snug">Set up the pipeline your agents will work</h1>
        <p class="text-muted-foreground mt-2.5 text-sm leading-relaxed">
          A board is a pipeline. Work enters as cards and moves stage by stage — agents claim the cards they're capable of, do the work, and hand off down the line. An approval gate pauses the flow so nothing moves past review without your sign-off.
        </p>
        <div class="mt-4 flex flex-wrap items-center gap-1.5">
          {#each BOARD_TEMPLATES[0].stages as s, i (s.key)}
            <span class="border-border mono rounded-[6px] border px-2 py-1 text-[11px] {s.ownerKind === 'capability' ? 'text-marigold' : s.gate === 'approval' ? 'text-coral' : ''}">{s.name}{#if s.gate === 'approval'}<span class="ml-1 opacity-70">gate</span>{/if}</span>
            {#if i < BOARD_TEMPLATES[0].stages.length - 1}<span style="color:var(--marigold)" aria-hidden="true">→</span>{/if}
          {/each}
        </div>
        <div class="mt-6 flex flex-wrap gap-2.5">
          <Button onclick={createFirstBoard} disabled={creating}>{creating ? 'Creating…' : 'Create my first board'}</Button>
          <Button variant="outline" onclick={openAgents}>Connect an agent</Button>
        </div>
      </div>
      <button onclick={onLogout} class="text-muted-foreground hover:text-foreground mono self-start text-xs">sign out</button>
      {#if error}<p class="text-coral mono text-xs">{error}</p>{/if}
    </div>
  {:else if !board}
    <div class="flex min-h-[70vh] flex-col items-center justify-center gap-3 text-center">
      <svg class="arrowmark size-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 12h15" /><path d="M13 6l6 6-6 6" /><path d="M3 9l3 3-3 3" />
      </svg>
      <div class="wordmark text-lg">Kaambaan</div>
      <div class="mono text-muted-foreground flex items-center gap-2 text-xs">
        <span class="live-dot"></span>{error ?? app.error ?? 'establishing link to the board…'}
      </div>
    </div>
  {:else}
    <!-- ===== FLIGHT DECK SHELL ===== -->
    <div class="app-shell flex h-screen overflow-hidden">
      <Rail />
      <div class="flex flex-1 flex-col min-w-0">
        <Topbar
          onOpenAgents={openAgents}
          onNewBoard={() => (showNewBoard = true)}
          onSettings={() => (showSettings = true)}
        />
        <div class="flex-1 min-h-0 overflow-auto">
          {#if app.screen === 'board'}
            {#if app.view === 'board'}
              <BoardKanban />
            {:else}
              <ListView />
            {/if}
          {:else if app.screen === 'triage'}
            <TriageInbox />
          {:else if app.screen === 'telemetry'}
            <Telemetry />
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- card drawer -->
  {#if app.openCardId}
    <CardDrawer />
  {/if}

  <!-- command palette -->
  <CommandPalette />

  <!-- agents manager modal -->
  {#if showConnect}
    <div class="fixed inset-0 z-40 flex items-center justify-center p-4">
      <button class="absolute inset-0 bg-black/55" onclick={closeConnect} aria-label="Close" tabindex="-1"></button>
      <div class="bg-surface border-border drawer-in relative w-full max-w-lg rounded-[12px] border p-6 shadow-2xl">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="eyebrow mb-1">agents</div>
            <h2 class="wordmark text-lg leading-snug">{minted ? 'Token created' : 'Agents in this workspace'}</h2>
          </div>
          <button onclick={closeConnect} aria-label="Close" class="text-muted-foreground hover:text-foreground shrink-0">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        {#if minted}
          <p class="text-muted-foreground mt-2.5 text-sm leading-relaxed">
            <span class="text-foreground">{minted.agent.name}</span>'s token —
            <span class="text-coral">copy it now, it won't be shown again.</span>
          </p>
          <div class="bg-inset border-border mono mt-3 flex items-center justify-between gap-2 rounded-[7px] border px-3 py-2 text-xs">
            <span class="truncate">{minted.token}</span>
            <button onclick={() => navigator.clipboard?.writeText(minted!.token)} class="shrink-0 hover:brightness-110" style="color:var(--marigold)">copy</button>
          </div>
          <div class="eyebrow mt-5 mb-1.5">add it to your MCP client — .mcp.json</div>
          <pre class="bg-inset border-border mono overflow-x-auto rounded-[7px] border p-3 text-[11px] leading-relaxed">{mcpSnippet}</pre>
          <p class="text-muted-foreground mt-2 text-xs leading-relaxed">The agent claims cards whose stage matches its capabilities, works them, and hands off down the pipeline.</p>
          <div class="mt-5 flex justify-end"><Button onclick={() => (minted = null)}>Done</Button></div>
        {:else}
          <!--
            This workspace's hub fleet. Above the agent list on purpose: an agent linked to a
            principal resolves nothing while the fleet is unlinked, so the order on screen is the
            order the two acts have to happen in.
          -->
          <div class="bg-inset border-border mt-4 rounded-[8px] border px-3 py-2">
            {#if editingFleet}
              <div class="flex items-center gap-1.5">
                <input
                  bind:value={fleetInput}
                  placeholder="fleet_…  (empty to unlink)"
                  class="bg-surface border-border mono min-w-0 flex-1 rounded-[5px] border px-2 py-1 text-[11px]"
                />
                <button onclick={() => void saveFleet()} disabled={fleetSaving} class="shrink-0 text-[11px] hover:brightness-110" style="color:var(--marigold)">save</button>
                <button onclick={() => (editingFleet = false)} class="text-muted-foreground shrink-0 text-[11px] hover:brightness-110">cancel</button>
              </div>
              {#if fleetError}<p class="text-coral mono mt-1 text-[10px] leading-relaxed">{fleetError}</p>{/if}
            {:else if workspace?.externalId}
              <div class="mono flex items-center gap-1.5 text-[11px]">
                <span class="text-muted-foreground shrink-0">fleet</span>
                <span class="truncate">{workspace.externalId}</span>
                <button onclick={startFleetEdit} class="text-muted-foreground ml-auto shrink-0 hover:brightness-110">change</button>
              </div>
            {:else}
              <div class="flex items-center gap-1.5">
                <p class="text-muted-foreground min-w-0 flex-1 text-[11px] leading-relaxed">
                  not linked to an agentpod fleet — link one so tokens its hub issues are accepted here
                </p>
                <button onclick={startFleetEdit} class="shrink-0 text-[11px] hover:brightness-110" style="color:var(--marigold)">link</button>
              </div>
            {/if}
          </div>

          <div class="mt-4 max-h-72 space-y-2 overflow-y-auto">
            {#if agents.length === 0}
              <p class="text-muted-foreground text-sm">No agents yet. Create one below — you'll get a token to point an AI agent at this workspace.</p>
            {:else}
              {#each agents as a (a.id)}
                <div class="bg-inset border-border group rounded-[8px] border px-3 py-2">
                  {#if editingAgentId === a.id}
                    <input
                      bind:value={editName}
                      aria-label="Agent name"
                      class="bg-surface border-border focus:border-marigold w-full rounded-[6px] border px-2 py-1 text-sm outline-none"
                    />
                    <div class="text-muted-foreground mt-2 mb-1 text-[11px]">capabilities it can claim:</div>
                    <CapabilityPicker bind:selected={editCaps} options={boardCaps} id="edit-caps-{a.id}" />
                    <div class="mt-2 flex items-center gap-1.5">
                      <label for="conc-{a.id}" class="text-muted-foreground text-[11px]">cards at once</label>
                      <input
                        id="conc-{a.id}"
                        type="number"
                        min="1"
                        bind:value={editConcurrency}
                        class="bg-surface border-border focus:border-marigold mono w-16 rounded-[6px] border px-2 py-1 text-[11px] outline-none"
                      />
                      <input
                        bind:value={editIconUrl}
                        placeholder="https://… avatar"
                        aria-label="Avatar URL for {a.name}"
                        class="bg-surface border-border focus:border-marigold mono min-w-0 flex-1 rounded-[6px] border px-2 py-1 text-[10px] outline-none"
                      />
                      <button onclick={() => void saveEditing()} disabled={savingEdit || editName.trim() === ''} class="mono shrink-0 text-[11px] hover:brightness-110 disabled:opacity-40" style="color:var(--marigold)">
                        {savingEdit ? 'saving…' : 'save'}
                      </button>
                      <button onclick={cancelEditing} class="text-muted-foreground hover:text-foreground shrink-0 text-[11px]">cancel</button>
                    </div>
                    {#if editError}<p class="text-coral mono mt-1 text-[10px] leading-relaxed">{editError}</p>{/if}
                  {:else}
                  <div class="flex items-center justify-between gap-2">
                    <div class="min-w-0">
                      <div class="truncate text-sm">{a.name}</div>
                      <div class="mt-1 flex flex-wrap items-center gap-1">
                        {#each a.capabilities as c (c)}<span class="border-border mono text-muted-foreground rounded-[4px] border px-1 py-0.5 text-[10px]">{c}</span>{/each}
                        {#if a.capabilities.length === 0}
                          <span class="text-coral text-[10px] leading-relaxed">no capabilities — this agent can claim nothing</span>
                        {/if}
                      </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <button onclick={() => startEditing(a)} aria-label="Edit agent {a.name}" title="Change this agent's name, capabilities and concurrency" class="text-muted-foreground hover:text-foreground text-[11px]">edit</button>
                      <button onclick={() => void onDeleteAgent(a)} aria-label="Delete agent" title="Delete this agent and every one of its tokens" class="text-muted-foreground hover:text-coral opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                      </button>
                    </div>
                  </div>
                  {/if}

                  <!-- suite principal: absent is the normal state for a standalone board, and says so -->
                  <div class="border-border/60 mt-2 border-t pt-2">
                    {#if linkingAgentId === a.id}
                      <div class="flex items-center gap-1.5">
                        <input
                          bind:value={principalInput}
                          placeholder="prn_… from agentpod"
                          onkeydown={(e) => { if (e.key === 'Enter') void saveLinking(); if (e.key === 'Escape') cancelLinking(); }}
                          class="bg-surface border-border focus:border-marigold mono min-w-0 flex-1 rounded-[6px] border px-2 py-1 text-[11px] outline-none"
                        />
                        <button onclick={() => void saveLinking()} disabled={linking} class="mono shrink-0 text-[11px] hover:brightness-110" style="color:var(--marigold)">{linking ? 'saving…' : 'save'}</button>
                        <button onclick={cancelLinking} class="text-muted-foreground hover:text-foreground shrink-0 text-[11px]">cancel</button>
                      </div>
                      {#if principalError}<p class="text-coral mono mt-1 text-[10px] leading-relaxed">{principalError}</p>{/if}
                    {:else if a.externalId}
                      <div class="flex items-center gap-1.5 text-[11px]">
                        <span class="text-muted-foreground shrink-0">principal</span>
                        <span class="mono truncate">{a.externalId}</span>
                        <button onclick={() => startLinking(a)} class="text-muted-foreground hover:text-foreground shrink-0">change</button>
                        <button onclick={() => void unlinkPrincipal(a)} class="text-muted-foreground hover:text-coral shrink-0">unlink</button>
                      </div>
                    {:else}
                      <button onclick={() => startLinking(a)} class="text-muted-foreground hover:text-foreground text-left text-[11px] leading-relaxed">
                        not linked to a suite principal — link one so its agentpod-issued tokens are accepted here too
                      </button>
                    {/if}
                  </div>

                  <!-- tokens: an agent with none cannot authenticate, and that is a real state, not silence -->
                  <div class="mt-2 flex flex-wrap items-center gap-1.5">
                    {#if a.tokenIds.length === 0}
                      <span class="text-muted-foreground text-[11px] leading-relaxed">
                        {a.externalId ? 'no kaambaan token — it authenticates with the tokens agentpod issues' : 'no active token — this agent cannot authenticate'}
                      </span>
                    {:else}
                      {#each a.tokenIds as t (t)}
                        <span class="border-border mono text-muted-foreground flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[10px]">
                          {t}
                          <button
                            onclick={() => void onRevokeToken(a.id, t)}
                            disabled={revokingTokenId === t}
                            aria-label="Revoke token {t}"
                            title="Revoke this token — immediate and irreversible"
                            class="hover:text-coral"
                          >
                            {revokingTokenId === t ? '…' : '×'}
                          </button>
                        </span>
                      {/each}
                    {/if}
                    <button
                      onclick={() => void onIssueToken(a)}
                      disabled={issuingFor === a.id}
                      class="mono shrink-0 text-[10px] hover:brightness-110 disabled:opacity-40"
                      style="color:var(--marigold)"
                    >
                      {issuingFor === a.id ? 'issuing…' : '+ token'}
                    </button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>

          <!--
            Agents that already exist in the suite.
            Absent entirely when this deployment has no hub — there is nothing
            to offer and nowhere to send anybody, so the section stays out of
            the way rather than showing a button that leads nowhere.
          -->
          {#if hubConfigured}
          <div class="border-border mt-5 border-t pt-4">
            {#if hubPrincipals === null}
              <button
                onclick={connectToHub}
                disabled={connecting}
                data-testid="connect-hub"
                class="text-muted-foreground hover:text-foreground text-xs underline"
              >
                {connecting ? 'Connecting…' : 'Connect to AgentPod'}
              </button>
            {:else if linkable.length === 0}
              <div class="eyebrow mb-2">from agentpod</div>
              <p class="text-muted-foreground text-xs">
                Every agent in the fleet already has one here.
              </p>
            {:else}
              <div class="eyebrow mb-2">from agentpod</div>
              <div class="flex flex-wrap gap-1.5" data-testid="hub-principal-list">
                {#each linkable as p (p.id)}
                  <button
                    onclick={() => togglePicked(p.id)}
                    title={p.id}
                    class="mono rounded-[6px] border px-2.5 py-1 text-[11px] transition {picked.includes(p.id)
                      ? 'border-marigold text-marigold'
                      : 'border-border text-muted-foreground hover:text-foreground'}"
                  >
                    {picked.includes(p.id) ? '✓ ' : ''}{p.handle}
                  </button>
                {/each}
              </div>
              <div class="text-muted-foreground mt-2.5 mb-1.5 text-xs">
                capabilities they can claim:
              </div>
              <CapabilityPicker bind:selected={importCaps} options={boardCaps} id="import-caps" />
              {#if importResult}
                <p class="mt-2 text-xs text-red-400" data-testid="import-failures">{importResult}</p>
              {/if}
              <div class="mt-4 flex justify-end">
                <Button
                  onclick={addPicked}
                  disabled={importing || picked.length === 0 || importCaps.length === 0}
                  data-testid="add-picked-agents"
                >
                  {importing ? 'Adding…' : `Add ${picked.length || ''}`.trim()}
                </Button>
              </div>
            {/if}
          </div>
          {/if}

          <!--
            People. Beside the agents rather than in a settings page, because both answer the same
            question — who and what may act in this workspace — and a role is now enforced, so a
            member refused an action needs to see who can grant it.
          -->
          <div class="border-border mt-5 border-t pt-4">
            <div class="eyebrow mb-2">people</div>
            <div class="space-y-1.5">
              {#each members as m (m.userId)}
                <div class="bg-inset border-border flex items-center gap-2 rounded-[7px] border px-2.5 py-1.5">
                  <span class="min-w-0 flex-1 truncate text-xs" title={m.email}>{m.name ?? m.email}</span>
                  <select
                    value={m.role}
                    onchange={(e) => void onRoleChange(m, e.currentTarget.value as Role)}
                    aria-label="Role for {m.email}"
                    title={ROLE_HELP[m.role]}
                    class="bg-surface border-border mono shrink-0 rounded-[5px] border px-1.5 py-0.5 text-[10px]"
                  >
                    <option value="viewer">viewer</option>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                  <button
                    onclick={() => void onRemoveMember(m)}
                    aria-label="Remove {m.email}"
                    class="text-muted-foreground hover:text-coral shrink-0"
                  >
                    <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </div>
              {/each}
            </div>
            <div class="mt-2 flex gap-1.5">
              <input
                bind:value={inviteEmail}
                type="email"
                placeholder="invite by email"
                aria-label="Email to invite"
                onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onInvite(); } }}
                class="bg-inset border-border focus:border-marigold min-w-0 flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
              />
              <select bind:value={inviteRole} aria-label="Role for the invitee" class="bg-inset border-border mono shrink-0 rounded-[6px] border px-1.5 text-[10px]">
                <option value="viewer">viewer</option>
                <option value="member">member</option>
                <option value="admin">admin</option>
                <option value="owner">owner</option>
              </select>
              <Button size="sm" variant="outline" onclick={() => void onInvite()} disabled={membersBusy || inviteEmail.trim() === ''}>Invite</Button>
            </div>
            <p class="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
              {inviteRole}: {ROLE_HELP[inviteRole]}. No email is sent — they sign in with GitHub and find this workspace waiting.
            </p>
            {#if membersError}<p class="text-coral mt-1.5 text-xs leading-relaxed">{membersError}</p>{/if}
          </div>

          <div class="border-border mt-5 border-t pt-4">
            <div class="eyebrow mb-2">new agent</div>
            <input
              bind:value={agentName}
              placeholder="e.g. Research bot"
              onkeydown={(e) => { if (e.key === 'Enter') void mintAgent(); }}
              class="bg-inset border-border focus:border-marigold w-full rounded-[7px] border px-3 py-2 text-sm outline-none"
            />
            <div class="text-muted-foreground mt-2.5 mb-1.5 text-xs">capabilities it can claim:</div>
            <CapabilityPicker bind:selected={newCaps} options={boardCaps} id="new-caps" />
            <div class="mt-4 flex justify-end">
              <Button onclick={mintAgent} disabled={minting || agentName.trim() === '' || newCaps.length === 0}>{minting ? 'Minting…' : 'Create + mint token'}</Button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <NewBoardDialog
    open={showNewBoard}
    onClose={() => (showNewBoard = false)}
    onCreated={(id) => void onBoardCreated(id)}
  />

  {#if board}
    <BoardSettings open={showSettings} {board} onClose={() => (showSettings = false)} onChanged={() => void app.refresh()} />
  {/if}
</main>

<script lang="ts">
  /**
   * Projects — the view, not the catalogue. Per project: name, state, health, target date, a
   * progress bar from `cardsDone / cardsTotal`, cost, and its milestones in `sortOrder` (Step 1).
   *
   * Every rollup number on this screen carries its own "as of" line (`formatAsOf`,
   * `./project-rollup.ts`) — Step 2's obligation, which no type can enforce on its own: a cross-
   * board total is stale the moment it returns, and a partial one is an admission the server
   * already made that this view must not bury.
   */
  import { app } from '$lib/stores/app.svelte';
  import {
    listProjects,
    getProject,
    getProjectRollup,
    createProject,
    deleteProject,
    createMilestone,
    deleteMilestone,
    type Project,
    type ProjectHealth,
    type Milestone,
    type ProjectRollup,
  } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { formatAsOf, progressPct } from './project-rollup';

  let projects = $state<Project[]>([]);
  let milestonesByProject = $state<Map<string, Milestone[]>>(new Map());
  let rollups = $state<Map<string, ProjectRollup>>(new Map());
  /**
   * `getProjectRollup` throws on failure rather than inventing a zeroed/partial placeholder
   * (its own doc comment, `$lib/api`) — a rollup the CLIENT invented to cover a failed fetch would
   * be the same dishonesty `partial` exists to name when the SERVER can't complete one. So a
   * failed fetch here renders nothing numeric at all, just this sentence.
   */
  let rollupErrors = $state<Map<string, string>>(new Map());
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function refresh(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      projects = await listProjects();
      // Keep the shared catalogue (the filter in `FilterBar`, the picker in `CardDrawer`) in step
      // with what this view just loaded — the same thing `app.refresh()` does for `app.labels`.
      app.projects = projects;
    } catch (e) {
      loadError = String(e);
      loading = false;
      return;
    }
    await Promise.all(projects.map((p) => loadProjectDetail(p.id)));
    loading = false;
  }

  async function loadProjectDetail(id: string): Promise<void> {
    const [detail, rollupOutcome] = await Promise.all([
      getProject(id),
      getProjectRollup(id)
        .then((rollup) => ({ ok: true as const, rollup }))
        .catch((e: unknown) => ({ ok: false as const, message: String(e) })),
    ]);
    if (detail) {
      milestonesByProject = new Map(milestonesByProject).set(id, detail.milestones);
    }
    if (rollupOutcome.ok) {
      rollups = new Map(rollups).set(id, rollupOutcome.rollup);
      const next = new Map(rollupErrors);
      next.delete(id);
      rollupErrors = next;
    } else {
      rollupErrors = new Map(rollupErrors).set(id, rollupOutcome.message);
    }
  }

  $effect(() => {
    void refresh();
  });

  // ---- create project ----
  let creatingProject = $state(false);
  let newProjectName = $state('');
  let newProjectTarget = $state('');
  let creatingProjectBusy = $state(false);
  let creatingError = $state<string | null>(null);

  async function addProject(): Promise<void> {
    const name = newProjectName.trim();
    if (name === '' || creatingProjectBusy) return;
    creatingProjectBusy = true;
    creatingError = null;
    try {
      const res = await createProject({ name, targetDate: newProjectTarget.trim() || undefined });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        creatingError = body?.error ?? `Couldn't create that project (${res.status})`;
        return;
      }
      newProjectName = '';
      newProjectTarget = '';
      creatingProject = false;
      await refresh();
    } finally {
      creatingProjectBusy = false;
    }
  }

  let deletingProject = $state<string | null>(null);
  async function removeProject(p: Project): Promise<void> {
    if (!confirm(`Delete "${p.name}"? Cards that carried it keep their projectId, which will no longer resolve.`)) return;
    deletingProject = p.id;
    try {
      const res = await deleteProject(p.id);
      if (res.ok) await refresh();
      else loadError = `Couldn't delete "${p.name}" (${res.status})`;
    } finally {
      deletingProject = null;
    }
  }

  // ---- milestones (the write-surface gap this view exists to close) ----
  let newMilestoneName = $state<Record<string, string>>({});
  let newMilestoneTarget = $state<Record<string, string>>({});
  let addingMilestoneFor = $state<string | null>(null);
  let milestoneError = $state<Record<string, string | null>>({});
  let removingMilestone = $state<string | null>(null);

  async function addMilestone(projectId: string): Promise<void> {
    const name = (newMilestoneName[projectId] ?? '').trim();
    if (name === '' || addingMilestoneFor) return;
    addingMilestoneFor = projectId;
    milestoneError = { ...milestoneError, [projectId]: null };
    try {
      const res = await createMilestone(projectId, { name, targetDate: (newMilestoneTarget[projectId] ?? '').trim() || undefined });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        milestoneError = { ...milestoneError, [projectId]: body?.error ?? `Couldn't add that milestone (${res.status})` };
        return;
      }
      newMilestoneName = { ...newMilestoneName, [projectId]: '' };
      newMilestoneTarget = { ...newMilestoneTarget, [projectId]: '' };
      await loadProjectDetail(projectId);
    } finally {
      addingMilestoneFor = null;
    }
  }

  async function removeMilestone(projectId: string, milestoneId: string): Promise<void> {
    removingMilestone = milestoneId;
    try {
      const res = await deleteMilestone(milestoneId);
      if (res.ok) await loadProjectDetail(projectId);
      else milestoneError = { ...milestoneError, [projectId]: `Couldn't remove that milestone (${res.status})` };
    } finally {
      removingMilestone = null;
    }
  }

  // ---- display helpers ----
  function fmtUsd(n: number): string {
    return `$${n.toFixed(2)}`;
  }
  function fmtDate(d: string | null): string | null {
    if (!d) return null;
    try {
      return new Date(d).toLocaleDateString();
    } catch {
      return d;
    }
  }
  function healthColor(h: ProjectHealth | null): string {
    if (h === 'on-track') return 'var(--live)';
    if (h === 'at-risk') return 'var(--marigold)';
    if (h === 'off-track') return 'var(--coral)';
    return 'var(--muted)';
  }
</script>

<div class="space-y-3 p-3">
  <div class="flex items-center justify-between gap-2">
    <h2 class="text-sm font-semibold">Projects</h2>
    <Button size="sm" variant="outline" onclick={() => (creatingProject = !creatingProject)}>
      {creatingProject ? 'Cancel' : '+ Project'}
    </Button>
  </div>

  {#if creatingProject}
    <div class="bg-inset border-border space-y-2 rounded-[8px] border p-3">
      <input
        bind:value={newProjectName}
        placeholder="Project name"
        aria-label="New project name"
        onkeydown={(e) => { if (e.key === 'Enter') void addProject(); }}
        class="bg-surface border-border focus:border-marigold w-full rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
      />
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">
          target
          <input type="date" bind:value={newProjectTarget} aria-label="Target date" class="bg-surface border-border focus:border-marigold rounded-[5px] border px-1.5 py-1 text-xs outline-none" />
        </label>
        <Button size="sm" onclick={() => void addProject()} disabled={newProjectName.trim() === '' || creatingProjectBusy}>
          {creatingProjectBusy ? 'Creating…' : 'Create'}
        </Button>
      </div>
      {#if creatingError}<p role="alert" class="text-coral text-[11px]">{creatingError}</p>{/if}
    </div>
  {/if}

  {#if loadError}
    <p role="alert" class="text-coral text-xs">{loadError}</p>
  {:else if loading && projects.length === 0}
    <p class="text-muted-foreground text-sm">Loading projects…</p>
  {:else if projects.length === 0}
    <p class="text-muted-foreground text-sm">
      No projects yet — <code class="mono">supi project add</code> or "+ Project" above.
    </p>
  {/if}

  <div class="space-y-3">
    {#each projects as p (p.id)}
      {@const rollup = rollups.get(p.id)}
      {@const rollupErr = rollupErrors.get(p.id)}
      {@const milestones = milestonesByProject.get(p.id) ?? []}
      <div class="bg-surface border-border rounded-[10px] border p-3">
        <div class="flex flex-wrap items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <h3 class="min-w-0 truncate text-sm font-semibold">{p.name}</h3>
              <span class="mono border-border text-muted-foreground shrink-0 rounded-[4px] border px-1 text-[9px]">{p.state}</span>
              {#if p.health}
                <span class="mono shrink-0 rounded-[4px] border px-1 text-[9px]" style="color:{healthColor(p.health)};border-color:{healthColor(p.health)}">{p.health}</span>
              {/if}
            </div>
            {#if p.targetDate}
              <div class="text-muted-foreground mono mt-0.5 text-[10px]">target {fmtDate(p.targetDate)}</div>
            {/if}
          </div>
          <button
            onclick={() => void removeProject(p)}
            disabled={deletingProject === p.id}
            aria-label="Delete project {p.name}"
            class="text-muted-foreground hover:text-coral shrink-0 text-[11px] disabled:opacity-50"
          >{deletingProject === p.id ? 'deleting…' : 'delete'}</button>
        </div>

        <!--
          Rollup. NEVER a number with no provenance beside it (Step 2) — `rollupErr` renders
          instead of a fabricated 0/0, `rollup` renders the bar and cost ONLY alongside
          `formatAsOf`, which already carries the partial notice when the server admitted one.
        -->
        <div class="mt-2.5">
          {#if rollupErr}
            <p class="text-coral text-[11px]">Rollup unavailable — {rollupErr}</p>
          {:else if rollup}
            <div class="flex items-baseline justify-between gap-2">
              <span class="mono text-[11px]">{rollup.cardsDone}/{rollup.cardsTotal} cards done</span>
              <span class="mono text-[11px]">{fmtUsd(rollup.costUsd)}</span>
            </div>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-inset">
              <div class="h-full rounded-full transition-all duration-1000" style="width:{progressPct(rollup)}%;background:var(--live)"></div>
            </div>
            <div class="text-muted-foreground mono mt-1 text-[10px]">
              {formatAsOf(rollup)}{#if rollup.cardsOverdue > 0} · {rollup.cardsOverdue} overdue{/if}
            </div>
          {:else}
            <p class="text-muted-foreground text-[11px]">Loading rollup…</p>
          {/if}
        </div>

        <!-- milestones, in sortOrder (the server's own order) -->
        <div class="mt-3">
          <div class="eyebrow mb-1">milestones</div>
          {#if milestones.length > 0}
            <div class="space-y-1">
              {#each milestones as m (m.id)}
                <div class="bg-inset border-border mono flex items-center gap-2 rounded-[6px] border px-2 py-1 text-[11px]">
                  <span class="min-w-0 flex-1 truncate">{m.name}</span>
                  {#if m.targetDate}<span class="text-muted-foreground shrink-0">{fmtDate(m.targetDate)}</span>{/if}
                  <button
                    onclick={() => void removeMilestone(p.id, m.id)}
                    disabled={removingMilestone === m.id}
                    class="text-muted-foreground hover:text-coral shrink-0 text-[10px] disabled:opacity-50"
                  >{removingMilestone === m.id ? '…' : 'remove'}</button>
                </div>
              {/each}
            </div>
          {:else}
            <p class="text-muted-foreground text-[11px]">No milestones yet.</p>
          {/if}
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            <input
              value={newMilestoneName[p.id] ?? ''}
              oninput={(e) => (newMilestoneName = { ...newMilestoneName, [p.id]: e.currentTarget.value })}
              onkeydown={(e) => { if (e.key === 'Enter') void addMilestone(p.id); }}
              placeholder="New milestone…"
              aria-label="New milestone name for {p.name}"
              class="bg-inset border-border focus:border-marigold min-w-0 flex-1 rounded-[6px] border px-2 py-1 text-[11px] outline-none"
            />
            <input
              type="date"
              value={newMilestoneTarget[p.id] ?? ''}
              oninput={(e) => (newMilestoneTarget = { ...newMilestoneTarget, [p.id]: e.currentTarget.value })}
              aria-label="Target date for new milestone on {p.name}"
              class="bg-inset border-border focus:border-marigold shrink-0 rounded-[6px] border px-2 py-1 text-[11px] outline-none"
            />
            <Button
              size="sm"
              variant="outline"
              onclick={() => void addMilestone(p.id)}
              disabled={(newMilestoneName[p.id] ?? '').trim() === '' || addingMilestoneFor === p.id}
            >{addingMilestoneFor === p.id ? 'Adding…' : 'Add'}</Button>
          </div>
          {#if milestoneError[p.id]}
            <p role="alert" class="text-coral mt-1 text-[11px]">{milestoneError[p.id]}</p>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>

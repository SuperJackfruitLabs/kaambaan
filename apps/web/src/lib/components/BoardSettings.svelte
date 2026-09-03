<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { renameBoard, setGithubConfig, setStages, getProfiles, createProfile, type BoardSnapshot, type Profile, type Stage } from '$lib/api';
  import { capabilityTag } from '@kaambaan/contract';

  let { board, onChanged }: { board: BoardSnapshot; onChanged: () => void } = $props();

  let nameInput = $state('');
  let githubSecret = $state('');
  let issueTrigger = $state(false);
  let profiles = $state<Profile[]>([]);
  let pKey = $state('');
  let pModel = $state('');
  let busy = $state('');
  let seeded = $state(false);

  /**
   * The pipeline, editable.
   *
   * A board's stages were written once at creation and there was no way to change any of them —
   * one typo in a stage name cost the board and every card on it. Held as a local draft so an
   * operator can reorder, retitle and retune several stages and save once; the server refuses the
   * whole payload if any part of it is impossible, so a half-applied pipeline never exists.
   *
   * A stage's KEY is identity — cards, runs and gates all carry it — so it is shown and not
   * editable. Changing a key is adding a stage and removing the old one, which the server's
   * emptiness rule then makes safe.
   */
  let draft = $state<Stage[]>([]);
  let stagesError = $state<string | null>(null);
  let newStageName = $state('');

  const cardsPerStage = $derived(
    board.cards.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.currentStageKey]: (acc[c.currentStageKey] ?? 0) + 1 }), {}),
  );

  // The shared spelling — the same one an agent's capabilities are stored with. A stage owner
  // and a capability are compared by exact equality, so they cannot be spelled by two functions.
  const slug = capabilityTag;

  /**
   * A capability lane's requirement, as one editable field.
   *
   * One capability stays `owner` — the shape every existing board already carries. A
   * comma-separated list becomes `requires`, so editing a stage never rewrites it into a new
   * shape just for having been opened.
   */
  function ownerParts(raw: string): string[] {
    return [...new Set(raw.split(',').map(capabilityTag).filter((c) => c !== ''))];
  }

  function ownerText(stage: Stage): string {
    if (stage.requires) return [...(stage.requires.all ?? stage.requires.any ?? [])].join(', ');
    return stage.owner ?? '';
  }

  function setOwner(stage: Stage, raw: string): void {
    const parts = ownerParts(raw);
    if (parts.length > 1) {
      const match = stage.requires?.any ? 'any' : 'all';
      stage.requires = match === 'any' ? { any: parts } : { all: parts };
      delete stage.owner;
    } else {
      delete stage.requires;
      stage.owner = parts[0] ?? '';
    }
  }

  function setMatch(stage: Stage, match: 'all' | 'any'): void {
    const parts = ownerParts(ownerText(stage));
    stage.requires = match === 'any' ? { any: parts } : { all: parts };
  }

  function addStage(): void {
    const name = newStageName.trim();
    if (name === '') return;
    let key = slug(name) || `stage-${draft.length + 1}`;
    // A duplicate key is refused by the server; suffixing here means the operator meets a working
    // stage rather than an error about something they cannot see.
    let n = 2;
    while (draft.some((s) => s.key === key)) key = `${slug(name)}-${n++}`;
    draft = [...draft, { key, name, order: draft.length }];
    newStageName = '';
  }

  function removeStage(key: string): void {
    draft = draft.filter((s) => s.key !== key).map((s, i) => ({ ...s, order: i }));
  }

  function move(index: number, by: number): void {
    const to = index + by;
    if (to < 0 || to >= draft.length) return;
    const next = [...draft];
    [next[index], next[to]] = [next[to]!, next[index]!];
    draft = next.map((s, i) => ({ ...s, order: i }));
  }

  async function saveStages(): Promise<void> {
    busy = 'stages';
    stagesError = null;
    try {
      const res = await setStages(board.boardId!, draft);
      if (!res.ok) {
        // The server's own sentence names the stage and how many cards are on it — the one fact
        // the operator needs in order to act.
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        stagesError = body?.error?.message ?? `Saving the pipeline failed (${res.status})`;
        return;
      }
      onChanged();
    } finally {
      busy = '';
    }
  }

  const webhookUrl = $derived(`${location.origin}/v1/boards/${board.boardId}/webhooks/github?tenant=${board.tenantId}`);

  $effect(() => {
    if (!seeded) {
      nameInput = board.name ?? '';
      issueTrigger = board.github.issueTrigger;
      draft = board.stages.map((s) => ({ ...s }));
      stagesError = null;
      void getProfiles(board.boardId!).then((p) => (profiles = p)).catch(() => (profiles = []));
      seeded = true;
    }
  });

  async function saveName(): Promise<void> {
    if (nameInput.trim() === '' || nameInput.trim() === board.name) return;
    busy = 'name';
    await renameBoard(board.boardId!, nameInput.trim());
    busy = '';
    onChanged();
  }

  function genSecret(): void {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    githubSecret = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  async function saveGithub(): Promise<void> {
    busy = 'github';
    await setGithubConfig(board.boardId!, { issueTrigger, ...(githubSecret.trim() !== '' ? { secret: githubSecret.trim() } : {}) });
    githubSecret = '';
    busy = '';
    onChanged();
  }

  async function addProfile(): Promise<void> {
    if (pKey.trim() === '') return;
    busy = 'profile';
    const res = await createProfile(board.boardId!, { key: pKey.trim(), model: pModel.trim() || undefined });
    if (res.ok) {
      pKey = '';
      pModel = '';
      profiles = await getProfiles(board.boardId!);
    }
    busy = '';
  }
</script>

<div class="mx-auto max-w-2xl">
  <div class="eyebrow mb-1">board settings</div>
  <h1 class="wordmark mb-4 text-lg leading-snug">{board.name}</h1>

  <div class="space-y-6">
        <!-- rename -->
        <section>
          <div class="eyebrow mb-2">name</div>
          <div class="flex gap-2">
            <input bind:value={nameInput} class="bg-inset border-border focus:border-marigold flex-1 rounded-[7px] border px-3 py-2 text-sm outline-none" />
            <Button size="sm" onclick={saveName} disabled={busy === 'name' || nameInput.trim() === '' || nameInput.trim() === board.name}>Rename</Button>
          </div>
        </section>

        <!-- stages -->
        <section>
          <div class="eyebrow mb-2">pipeline</div>
          <p class="text-muted-foreground mb-3 text-xs leading-relaxed">
            The stages a card moves through. A stage's <span class="mono">key</span> is what every card,
            run and gate refers to, so it cannot be renamed — add a stage and remove the old one instead.
            A stage holding cards cannot be removed until they are moved.
          </p>

          <div class="space-y-2">
            {#each draft as stage, i (stage.key)}
              <div class="bg-inset border-border rounded-[8px] border px-2.5 py-2">
                <div class="flex items-center gap-1.5">
                  <div class="flex shrink-0 flex-col">
                    <button onclick={() => move(i, -1)} disabled={i === 0} aria-label="Move {stage.name} earlier" class="text-muted-foreground hover:text-foreground text-[9px] leading-none disabled:opacity-30">▲</button>
                    <button onclick={() => move(i, 1)} disabled={i === draft.length - 1} aria-label="Move {stage.name} later" class="text-muted-foreground hover:text-foreground text-[9px] leading-none disabled:opacity-30">▼</button>
                  </div>
                  <input
                    bind:value={stage.name}
                    aria-label="Name of stage {stage.key}"
                    class="bg-surface border-border focus:border-marigold min-w-0 flex-1 rounded-[6px] border px-2 py-1 text-sm outline-none"
                  />
                  <span class="mono text-muted-foreground shrink-0 text-[10px]">{stage.key}</span>
                  <button
                    onclick={() => removeStage(stage.key)}
                    disabled={(cardsPerStage[stage.key] ?? 0) > 0 || draft.length === 1}
                    aria-label="Remove stage {stage.name}"
                    title={(cardsPerStage[stage.key] ?? 0) > 0 ? `Holds ${cardsPerStage[stage.key]} card(s) — move them first` : 'Remove this stage'}
                    class="text-muted-foreground hover:text-coral shrink-0 disabled:opacity-30"
                  >
                    <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </div>
                <div class="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                  <select
                    bind:value={stage.ownerKind}
                    aria-label="Who works stage {stage.name}"
                    class="bg-surface border-border mono rounded-[5px] border px-1.5 py-0.5 text-[10px]"
                  >
                    <option value="human">human</option>
                    <option value="capability">agent</option>
                  </select>
                  {#if stage.ownerKind === 'capability'}
                    <input
                      value={ownerText(stage)}
                      onblur={(e) => setOwner(stage, e.currentTarget.value)}
                      placeholder="capability"
                      aria-label="Capability required for stage {stage.name}"
                      title="An agent holding this capability claims cards here. Separate several with commas."
                      class="bg-surface border-border mono w-40 rounded-[5px] border px-1.5 py-0.5 text-[10px]"
                    />
                    <!-- Only meaningful once a lane names more than one capability. -->
                    {#if ownerParts(ownerText(stage)).length > 1}
                      <div class="border-border flex shrink-0 overflow-hidden rounded-[5px] border text-[10px]">
                        <button onclick={() => setMatch(stage, 'all')} class="mono px-1.5 py-0.5 {stage.requires?.any ? 'text-muted-foreground' : 'bg-marigold text-primary-foreground'}" title="An agent must hold every one">all</button>
                        <button onclick={() => setMatch(stage, 'any')} class="mono border-border border-l px-1.5 py-0.5 {stage.requires?.any ? 'bg-marigold text-primary-foreground' : 'text-muted-foreground'}" title="Holding any one is enough">any</button>
                      </div>
                    {/if}
                  {/if}
                  <label class="text-muted-foreground flex items-center gap-1">
                    <input type="checkbox" checked={stage.gate === 'approval'} onchange={(e) => (stage.gate = e.currentTarget.checked ? 'approval' : 'none')} class="accent-marigold" />
                    approval gate
                  </label>
                  <label class="text-muted-foreground flex items-center gap-1">
                    wip
                    <input
                      type="number"
                      min="1"
                      value={stage.wipLimit ?? ''}
                      onchange={(e) => (stage.wipLimit = e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
                      placeholder="—"
                      aria-label="WIP limit for stage {stage.name}"
                      class="bg-surface border-border mono w-14 rounded-[5px] border px-1.5 py-0.5 text-[10px]"
                    />
                  </label>
                  {#if (cardsPerStage[stage.key] ?? 0) > 0}
                    <span class="text-muted-foreground mono ml-auto text-[10px]">{cardsPerStage[stage.key]} card{cardsPerStage[stage.key] === 1 ? '' : 's'}</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          <div class="mt-2 flex gap-1.5">
            <input
              bind:value={newStageName}
              placeholder="add a stage"
              onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStage(); } }}
              class="bg-inset border-border focus:border-marigold min-w-0 flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
            />
            <Button size="sm" variant="outline" onclick={addStage} disabled={newStageName.trim() === ''}>Add</Button>
          </div>

          {#if stagesError}<p class="text-coral mt-2 text-xs leading-relaxed">{stagesError}</p>{/if}
          <div class="mt-3 flex justify-end"><Button size="sm" onclick={saveStages} disabled={busy === 'stages'}>{busy === 'stages' ? 'Saving…' : 'Save pipeline'}</Button></div>
        </section>

        <!-- github -->
        <section>
          <div class="eyebrow mb-2">github integration</div>
          <p class="text-muted-foreground mb-3 text-xs leading-relaxed">
            In your repo → <span class="text-foreground">Settings → Webhooks → Add webhook</span>: paste the Payload URL and the same Secret below (content type <span class="mono">application/json</span>). Then turn on the trigger to open a card for each new issue.
          </p>

          <div class="text-muted-foreground mono mb-1 text-[10px]">payload url</div>
          <div class="bg-inset border-border mono mb-3 flex items-center justify-between gap-2 overflow-hidden rounded-[7px] border px-2.5 py-1.5 text-[10px]">
            <span class="truncate">{webhookUrl}</span>
            <button onclick={() => navigator.clipboard?.writeText(webhookUrl)} class="shrink-0" style="color:var(--marigold)">copy</button>
          </div>

          <div class="text-muted-foreground mono mb-1 text-[10px]">
            secret{#if board.github.webhookConfigured}<span style="color:var(--live)"> · configured</span>{/if}
          </div>
          <div class="mb-3 flex gap-1.5">
            <input
              bind:value={githubSecret}
              placeholder={board.github.webhookConfigured ? 'generate or type a new secret to replace' : 'generate or paste a secret'}
              class="bg-inset border-border focus:border-marigold mono min-w-0 flex-1 rounded-[7px] border px-2.5 py-2 text-xs outline-none"
            />
            <Button size="sm" variant="outline" onclick={genSecret}>Generate</Button>
            <button onclick={() => navigator.clipboard?.writeText(githubSecret)} disabled={githubSecret === ''} title="Copy secret" class="shrink-0 px-1 text-xs disabled:opacity-40" style="color:var(--marigold)">copy</button>
          </div>
          <label class="flex select-none items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={issueTrigger} class="accent-marigold" />
            <span>Open a card for each new GitHub issue</span>
          </label>
          <!--
            A webhook fires with nobody present, so the authority a trigger-born card carries has
            to have been recorded here, when the repository was wired. Saying so is the point: a
            board with the trigger on and no grant produces cards that are refused at claim time,
            and nothing else in the product notices.
          -->
          {#if board.github.triggerGrantCount === null}
            <p class="text-muted-foreground mt-2 text-xs leading-relaxed">
              Saving carries your current dispatch authority onto every card this trigger creates.
              Without it those cards cannot be claimed by any agent.
            </p>
          {:else}
            <p class="text-muted-foreground mt-2 text-xs leading-relaxed">
              Cards from this trigger may be dispatched to
              <span class="text-foreground">{board.github.triggerGrantCount}</span>
              {board.github.triggerGrantCount === 1 ? 'agent' : 'agents'}. Save again to refresh that.
            </p>
          {/if}
          <div class="mt-3 flex justify-end"><Button size="sm" variant="outline" onclick={saveGithub} disabled={busy === 'github'}>Save GitHub settings</Button></div>
        </section>

        <!-- profiles -->
        <section>
          <div class="eyebrow mb-2">agent profiles</div>
          <p class="text-muted-foreground mb-2 text-xs leading-relaxed">Named run configs (model, etc.) an agent can claim with.</p>
          {#if profiles.length > 0}
            <div class="mb-2.5 space-y-1.5">
              {#each profiles as p (p.key)}
                <div class="bg-inset border-border mono flex items-center justify-between gap-2 rounded-[7px] border px-2.5 py-1.5 text-[11px]">
                  <span>{p.key}</span>
                  <span class="text-muted-foreground">{p.model ?? '—'}</span>
                </div>
              {/each}
            </div>
          {/if}
          <div class="flex flex-wrap gap-1.5">
            <input bind:value={pKey} placeholder="key — e.g. opus-careful" class="bg-inset border-border focus:border-marigold mono min-w-0 flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs outline-none" />
            <input bind:value={pModel} placeholder="model" class="bg-inset border-border focus:border-marigold mono min-w-0 flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs outline-none" />
            <Button size="sm" variant="outline" onclick={addProfile} disabled={busy === 'profile' || pKey.trim() === ''}>Add</Button>
          </div>
        </section>
  </div>
</div>

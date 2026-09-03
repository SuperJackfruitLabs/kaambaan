<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { createBoard, getCapabilities, BOARD_TEMPLATES, type Stage, type CapabilityRecord } from '$lib/api';
  import { capabilityTag } from '@kaambaan/contract';
  import { onMount } from 'svelte';

  /**
   * The workspace's capability registry, so a lane nobody can work is visible BEFORE the board
   * exists rather than after.
   *
   * This is the check that would have caught the whole mismatch: templates asked for capabilities
   * no agent held, boards were created with lanes nothing could claim, and the only symptom was a
   * card that never moved. A stage with no one to work it is a real state — you may be about to
   * hire — so it warns rather than refuses.
   */
  let registry = $state<CapabilityRecord[]>([]);
  onMount(() => {
    void getCapabilities().then((c) => (registry = c)).catch(() => (registry = []));
  });


  let { open = false, onClose, onCreated }: { open?: boolean; onClose: () => void; onCreated: (boardId: string) => void } = $props();

  // A stage being edited. `owner` is the capability an agent must hold to claim an agent lane.
  interface DraftStage {
    name: string;
    ownerKind: 'capability' | 'human';
    /**
     * What an agent must hold. One capability is the ordinary case; a comma-separated list makes
     * this a requirement SET, and `match` then says whether every member binds or any one does.
     */
    owner: string;
    match: 'all' | 'any';
    gate: boolean;
    wipLimit: number | null;
  }

/** The capabilities an owner field names — one, or a comma-separated set. */
function ownerParts(raw: string): string[] {
  return [...new Set(raw.split(',').map(capabilityTag).filter((c) => c !== ''))];
}

  let name = $state('');
  let stages = $state<DraftStage[]>([]);

  const staffed = $derived(new Set(registry.filter((c) => c.agentCount > 0).map((c) => c.key)));
  /** Capabilities this pipeline asks for that no agent in the workspace holds. */
  const unstaffed = $derived([
    ...new Set(
      stages
        .filter((s) => s.ownerKind === 'capability')
        .flatMap((s) => ownerParts(s.owner))
        .filter((c) => !staffed.has(c)),
    ),
  ]);
  let creating = $state(false);
  let error = $state<string | null>(null);
  let seeded = $state(false);

  function fromTemplate(tplStages: Stage[]): DraftStage[] {
    return tplStages.map((s) => ({
      name: s.name,
      ownerKind: s.ownerKind ?? 'human',
      owner: s.requires ? [...(s.requires.all ?? s.requires.any ?? [])].join(', ') : (s.owner ?? ''),
      match: s.requires?.any ? 'any' : 'all',
      gate: s.gate === 'approval',
      wipLimit: s.wipLimit ?? null,
    }));
  }

  // Seed from the Agent pipeline the first time the dialog opens.
  $effect(() => {
    if (open && !seeded) {
      stages = fromTemplate(BOARD_TEMPLATES[0]!.stages);
      seeded = true;
    }
    if (!open) seeded = false;
  });

  function seedFrom(id: string): void {
    const tpl = BOARD_TEMPLATES.find((t) => t.id === id);
    stages = tpl ? fromTemplate(tpl.stages) : [{ name: 'To do', ownerKind: 'human', owner: '', match: 'all', gate: false, wipLimit: null }];
  }

  function addStage(): void {
    stages = [...stages, { name: '', ownerKind: 'capability', owner: '', match: 'all', gate: false, wipLimit: null }];
  }
  function removeStage(i: number): void {
    stages = stages.filter((_, idx) => idx !== i);
  }
  function move(i: number, dir: -1 | 1): void {
    const j = i + dir;
    if (j < 0 || j >= stages.length) return;
    const next = [...stages];
    [next[i], next[j]] = [next[j]!, next[i]!];
    stages = next;
  }

  // The shared spelling, so a template's stage owner and an agent's capability are the same
  // string. This was a private copy of the same rule; two copies of a rule is one rule and one
  // bug waiting.
  const slug = capabilityTag;

  const valid = $derived(name.trim() !== '' && stages.length > 0 && stages.every((s) => s.name.trim() !== '' && (s.ownerKind === 'human' || (s.owner || s.name).trim() !== '')));

  function build(): Stage[] {
    const used = new Set<string>();
    return stages.map((s, i) => {
      let key = slug(s.name) || `stage-${i}`;
      while (used.has(key)) key = `${key}-${i}`;
      used.add(key);
      const stage: Stage = { key, name: s.name.trim(), order: i, ownerKind: s.ownerKind };
      if (s.ownerKind === 'capability') {
        // One capability stays `owner` — the shape every existing board and every consumer
        // already reads. Only a genuine set becomes `requires`, so nothing is rewritten to a new
        // shape just for being edited.
        const parts = ownerParts(s.owner);
        if (parts.length > 1) stage.requires = s.match === 'any' ? { any: parts } : { all: parts };
        else stage.owner = parts[0] ?? slug(s.name);
      }
      if (s.gate) stage.gate = 'approval';
      if (s.wipLimit && s.wipLimit > 0) stage.wipLimit = s.wipLimit;
      return stage;
    });
  }

  async function create(): Promise<void> {
    if (!valid) return;
    creating = true;
    error = null;
    try {
      onCreated(await createBoard(name.trim(), build()));
      name = '';
    } catch (e) {
      error = String(e);
    } finally {
      creating = false;
    }
  }
</script>

{#if open}
  <div class="fixed inset-0 z-40 flex items-center justify-center p-4">
    <button class="absolute inset-0 bg-black/55" onclick={onClose} aria-label="Close" tabindex="-1"></button>
    <div class="bg-surface border-border drawer-in relative flex max-h-[90vh] w-full max-w-xl flex-col rounded-[12px] border shadow-2xl">
      <div class="border-border flex items-start justify-between gap-3 border-b p-6 pb-4">
        <div>
          <div class="eyebrow mb-1">new board</div>
          <h2 class="wordmark text-lg leading-snug">Design a pipeline</h2>
        </div>
        <button onclick={onClose} aria-label="Close" class="text-muted-foreground hover:text-foreground shrink-0">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-6">
        <input
          bind:value={name}
          placeholder="Board name — e.g. Launch"
          class="bg-inset border-border focus:border-marigold w-full rounded-[7px] border px-3 py-2 text-sm outline-none"
        />

        <div class="eyebrow mt-4 mb-2">start from a template</div>
        <div class="flex flex-wrap gap-1.5">
          {#each BOARD_TEMPLATES as tpl (tpl.id)}
            <button onclick={() => seedFrom(tpl.id)} title={tpl.description} class="border-border hover:border-marigold/60 mono text-muted-foreground hover:text-foreground rounded-[6px] border px-2 py-1 text-[11px]">{tpl.name}</button>
          {/each}
          <button onclick={() => seedFrom('blank')} title="Start with one empty stage" class="border-border hover:border-marigold/60 mono text-muted-foreground hover:text-foreground rounded-[6px] border px-2 py-1 text-[11px]">Blank</button>
        </div>

        <div class="eyebrow mt-5 mb-2">stages</div>
        <div class="space-y-2">
          {#each stages as stage, i (i)}
            <div class="bg-inset border-border rounded-[9px] border p-2.5">
              <div class="flex items-center gap-2">
                <div class="flex flex-col">
                  <button onclick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" class="text-muted-foreground hover:text-foreground leading-none disabled:opacity-30"><svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M18 15l-6-6-6 6" /></svg></button>
                  <button onclick={() => move(i, 1)} disabled={i === stages.length - 1} aria-label="Move down" class="text-muted-foreground hover:text-foreground leading-none disabled:opacity-30"><svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg></button>
                </div>
                <input bind:value={stage.name} placeholder="Stage name" class="bg-surface border-border focus:border-marigold flex-1 rounded-[6px] border px-2.5 py-1.5 text-sm outline-none" />
                <div class="border-border flex shrink-0 overflow-hidden rounded-[6px] border text-[11px]">
                  <button onclick={() => (stage.ownerKind = 'capability')} class="mono px-2 py-1.5 {stage.ownerKind === 'capability' ? 'bg-marigold text-primary-foreground' : 'text-muted-foreground'}">agent</button>
                  <button onclick={() => (stage.ownerKind = 'human')} class="mono border-border border-l px-2 py-1.5 {stage.ownerKind === 'human' ? 'bg-marigold text-primary-foreground' : 'text-muted-foreground'}">human</button>
                </div>
                <button onclick={() => removeStage(i)} aria-label="Remove stage" class="text-muted-foreground hover:text-coral shrink-0"><svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-7 text-xs">
                {#if stage.ownerKind === 'capability'}
                  <label class="text-muted-foreground flex items-center gap-1.5">
                    capability
                    <input bind:value={stage.owner} placeholder={slug(stage.name) || 'e.g. research'} class="bg-surface border-border focus:border-marigold mono w-40 rounded-[5px] border px-1.5 py-0.5 text-[11px] outline-none" />
                  </label>
                  <!--
                    The all/any choice only exists once a lane names more than one capability;
                    offering it for a single tag would be a control that decides nothing.
                  -->
                  {#if ownerParts(stage.owner).length > 1}
                    <div class="border-border flex shrink-0 overflow-hidden rounded-[5px] border text-[10px]">
                      <button onclick={() => (stage.match = 'all')} class="mono px-1.5 py-0.5 {stage.match === 'all' ? 'bg-marigold text-primary-foreground' : 'text-muted-foreground'}" title="An agent must hold every one">all</button>
                      <button onclick={() => (stage.match = 'any')} class="mono border-border border-l px-1.5 py-0.5 {stage.match === 'any' ? 'bg-marigold text-primary-foreground' : 'text-muted-foreground'}" title="Holding any one is enough">any</button>
                    </div>
                  {/if}
                {:else}
                  <label class="text-muted-foreground flex items-center gap-1.5 select-none">
                    <input type="checkbox" bind:checked={stage.gate} class="accent-coral" /> approval gate
                  </label>
                {/if}
                <label class="text-muted-foreground flex items-center gap-1.5">
                  WIP
                  <input type="number" min="0" bind:value={stage.wipLimit} placeholder="∞" class="bg-surface border-border focus:border-marigold mono w-14 rounded-[5px] border px-1.5 py-0.5 text-[11px] outline-none" />
                </label>
              </div>
            </div>
          {/each}
        </div>
        <button onclick={addStage} class="text-marigold hover:bg-inset mt-2 flex w-full items-center justify-center gap-1.5 rounded-[7px] border border-dashed border-[var(--line)] px-2 py-2 text-xs">
          <span class="text-sm leading-none">+</span> Add stage
        </button>

        <!--
          A lane no agent can work. Not an error — you may be about to hire, or to staff an
          existing agent — but never a surprise. This is the check that would have caught the
          original mismatch, where a template asked for capabilities nobody held and the only
          symptom was a card that never moved.
        -->
        {#if unstaffed.length > 0}
          <p class="text-coral mt-3 text-xs leading-relaxed" data-testid="unstaffed-warning">
            No agent holds {unstaffed.join(', ')}. Those lanes will hold cards nothing can claim
            until you staff an agent with {unstaffed.length === 1 ? 'it' : 'them'}.
          </p>
        {/if}

        {#if error}<p class="text-coral mono mt-3 text-xs">{error}</p>{/if}
      </div>

      <div class="border-border flex justify-end gap-2 border-t p-6 pt-4">
        <Button variant="ghost" onclick={onClose}>Cancel</Button>
        <Button onclick={create} disabled={creating || !valid}>{creating ? 'Creating…' : 'Create board'}</Button>
      </div>
    </div>
  </div>
{/if}

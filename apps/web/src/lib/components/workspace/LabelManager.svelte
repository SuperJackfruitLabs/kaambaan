<script lang="ts">
  /**
   * The label catalogue — the write-surface gap the audit named: `createLabel`/`updateLabel`/
   * `deleteLabel` (`$lib/api`) have been exported since Phase 1 with no caller anywhere in this
   * app, so a label could be created by typing a name into a card and then never renamed,
   * recoloured or removed. `renameLabel`/`recolourLabel`/`removeLabel` (`./label-manager.ts`) are
   * that caller; this component is their UI.
   *
   * **`origin` is not shown.** The brief asks for it — "List the catalogue with each label's
   * origin, so an operator can see which were inferred from a typo" — and the label this app
   * writes DOES carry one (`origin: 'inferred'`, migration 0011, same treatment `CapabilitiesTab`
   * already gives a capability that "appeared as a stage owner nobody ever defined"). But
   * `GET /v1/labels` (`apps/api/src/index.ts`) answers with `db/labels.ts`'s `listLabels`, whose
   * `COLUMNS` constant is `id, tenant_id AS tenantId, name, colour, created_at AS createdAt` — it
   * never selects `origin` — and the client `Label` type (`$lib/api`) does not declare the field
   * either. Both are a server field and a server-side column list, respectively; out of this
   * task's scope (`apps/api/**`, `apps/web/src/lib/api.ts`). Surfaced in the task report rather
   * than worked around here.
   */
  import { listLabels, createLabel, updateLabel, deleteLabel, type Label } from '$lib/api';
  import { renameLabel, recolourLabel, removeLabel } from './label-manager';
  import { Button } from '$lib/components/ui/button';

  let labels = $state<Label[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function refresh(): Promise<void> {
    labels = await listLabels();
    loading = false;
  }
  $effect(() => {
    void refresh();
  });

  const deps = { updateLabel, deleteLabel };

  // ---- rename (inline, like CapabilitiesTab's description field: edit on blur) ----
  async function onRename(l: Label, name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === l.name) return;
    error = null;
    const res = await renameLabel(deps, l.id, trimmed);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      error = body?.error ?? `Couldn't rename that label (${res.status})`;
    }
    await refresh();
  }

  // ---- recolour ----
  async function onRecolour(l: Label, colour: string): Promise<void> {
    if (colour === l.colour) return;
    error = null;
    const res = await recolourLabel(deps, l.id, colour);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      error = body?.error ?? `Couldn't recolour that label (${res.status})`;
    }
    await refresh();
  }

  // ---- remove ----
  let removing = $state<string | null>(null);
  async function onRemove(l: Label): Promise<void> {
    if (!confirm(`Delete the label "${l.name}"? Cards carrying it will drop it on their next edit.`)) return;
    removing = l.id;
    error = null;
    try {
      const res = await removeLabel(deps, l.id);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        error = body?.error ?? `Couldn't remove that label (${res.status})`;
      }
      await refresh();
    } finally {
      removing = null;
    }
  }

  // ---- create ----
  let newName = $state('');
  let newColour = $state('#f5a623');
  let creating = $state(false);
  async function add(): Promise<void> {
    const name = newName.trim();
    if (name === '' || creating) return;
    creating = true;
    error = null;
    try {
      const res = await createLabel({ name, colour: newColour });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        error = body?.error ?? `Couldn't add that label (${res.status})`;
        return;
      }
      newName = '';
      await refresh();
    } finally {
      creating = false;
    }
  }
</script>

<div class="space-y-2">
  {#if loading}
    <p class="text-muted-foreground text-sm">Loading labels…</p>
  {:else if labels.length === 0}
    <p class="text-muted-foreground text-sm">Nothing yet. A card's Labels field creates one, or name one below.</p>
  {/if}

  {#each labels as l (l.id)}
    <div class="bg-surface border-border flex items-center gap-2 rounded-[10px] border px-3 py-2.5">
      <input
        type="color"
        value={l.colour}
        onchange={(e) => void onRecolour(l, e.currentTarget.value)}
        aria-label="Colour for {l.name}"
        class="h-6 w-6 shrink-0 cursor-pointer rounded-[5px] border-0 bg-transparent p-0"
      />
      <input
        value={l.name}
        onblur={(e) => { const v = e.currentTarget.value; if (v !== l.name) void onRename(l, v); }}
        onkeydown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        aria-label="Name for label {l.name}"
        class="bg-inset border-border focus:border-marigold min-w-0 flex-1 rounded-[6px] border px-2 py-1 text-xs"
      />
      <button
        onclick={() => void onRemove(l)}
        disabled={removing === l.id}
        aria-label="Remove label {l.name}"
        class="text-muted-foreground hover:text-coral tap shrink-0 rounded-[6px] disabled:opacity-50"
      >
        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  {/each}
</div>

<div class="mt-4 flex items-center gap-2">
  <input
    type="color"
    bind:value={newColour}
    aria-label="New label colour"
    class="h-8 w-8 shrink-0 cursor-pointer rounded-[6px] border-0 bg-transparent p-0"
  />
  <input
    bind:value={newName}
    placeholder="add a label"
    aria-label="New label name"
    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
    class="bg-inset border-border focus:border-marigold mono min-w-0 flex-1 rounded-[8px] border px-3 py-2 text-xs"
  />
  <Button variant="outline" onclick={() => void add()} disabled={newName.trim() === '' || creating}>
    {creating ? 'Adding…' : 'Add'}
  </Button>
</div>

{#if error}<p role="alert" class="text-coral mt-3 text-xs leading-relaxed">{error}</p>{/if}

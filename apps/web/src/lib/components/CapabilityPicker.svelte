<script lang="ts">
  /**
   * Choose the capabilities an agent claims by.
   *
   * The options are the board's OWN stage capabilities, not a fixed list. Three values —
   * research, review, publish — used to be hardcoded here while the shipped templates defined
   * stages needing code, test, deploy and triage, so an agent could not be staffed to most of the
   * templates the product ships with. A stage's `owner` slug is the only thing `stageMatches`
   * ever compares against, so it is the only honest source for this list.
   *
   * The free-text field stays, because a board can be wired to stages this deployment has not
   * created yet — an agent may legitimately hold a capability no current stage names.
   */
  let {
    selected = $bindable<string[]>([]),
    options = [] as string[],
    id = 'caps',
  }: { selected?: string[]; options?: string[]; id?: string } = $props();

  let custom = $state('');

  /** Match the server's normalisation, so what is shown is what will be stored. */
  function normalise(v: string): string {
    return v.trim().toLowerCase();
  }

  const shown = $derived([...new Set([...options.map(normalise), ...selected.map(normalise)])].filter(Boolean).sort());

  function toggle(cap: string): void {
    selected = selected.includes(cap) ? selected.filter((c) => c !== cap) : [...selected, cap];
  }

  function addCustom(): void {
    const v = normalise(custom);
    if (v === '') return;
    if (!selected.includes(v)) selected = [...selected, v];
    custom = '';
  }
</script>

<div class="flex flex-wrap gap-1.5">
  {#each shown as cap (cap)}
    <button
      type="button"
      onclick={() => toggle(cap)}
      aria-pressed={selected.includes(cap)}
      class="mono rounded-[6px] border px-2.5 py-1 text-[11px] transition {selected.includes(cap)
        ? 'border-marigold text-marigold'
        : 'border-border text-muted-foreground hover:text-foreground'}"
    >
      {selected.includes(cap) ? '✓ ' : ''}{cap}
    </button>
  {/each}
  {#if shown.length === 0}
    <span class="text-muted-foreground text-[11px] leading-relaxed">
      This board's stages name no agent capabilities — add one below, or give a stage an agent owner.
    </span>
  {/if}
</div>

<div class="mt-1.5 flex items-center gap-1.5">
  <input
    bind:value={custom}
    id="{id}-custom"
    placeholder="add another capability"
    onkeydown={(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addCustom();
      }
    }}
    class="bg-surface border-border focus:border-marigold mono min-w-0 flex-1 rounded-[6px] border px-2 py-1 text-[11px] outline-none"
  />
  <button
    type="button"
    onclick={addCustom}
    disabled={custom.trim() === ''}
    class="mono shrink-0 text-[11px] hover:brightness-110 disabled:opacity-40"
    style="color:var(--marigold)">add</button
  >
</div>

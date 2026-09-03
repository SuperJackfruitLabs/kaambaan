<script lang="ts">
  /**
   * Six filter axes, and — the part that was missing — what is currently on.
   *
   * The old filter was a popover in the topbar with no indication outside it, so a filtered board
   * looked exactly like a board with fewer cards on it. Every active filter now renders as a
   * removable chip beside the control: a board must never silently misrepresent what it is showing.
   */
  import { app } from '$lib/stores/app.svelte';

  let open = $state(false);
  let el = $state<HTMLDivElement | null>(null);

  const f = $derived(app.filters);
  const states = $derived(app.boardStates());
  const owners = $derived(app.boardOwners());

  /** One chip per active filter, each knowing how to switch itself off. */
  const active = $derived([
    ...f.states.map((s) => ({ key: `state:${s}`, label: s, clear: () => (app.filters.states = f.states.filter((x) => x !== s)) })),
    ...f.owners.map((o) => ({ key: `owner:${o}`, label: o, clear: () => (app.filters.owners = f.owners.filter((x) => x !== o)) })),
    ...(f.minPriority !== null ? [{ key: 'pri', label: `P${f.minPriority}+`, clear: () => (app.filters.minPriority = null) }] : []),
    ...(f.needsReview ? [{ key: 'rev', label: 'needs review', clear: () => (app.filters.needsReview = false) }] : []),
    ...(f.live ? [{ key: 'live', label: 'working', clear: () => (app.filters.live = false) }] : []),
    ...(f.overBudget ? [{ key: 'bud', label: 'over budget', clear: () => (app.filters.overBudget = false) }] : []),
  ]);

  function toggle<T>(list: T[], v: T): T[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }
</script>

<svelte:window onclick={(e) => { if (open && el && !el.contains(e.target as Node)) open = false; }} />

<div class="relative flex min-w-0 flex-1 items-center gap-1.5" bind:this={el}>
  <button
    onclick={() => (open = !open)}
    aria-expanded={open}
    class="mono border-border hover:border-marigold/50 shrink-0 rounded-[7px] border px-2.5 text-[11px] {active.length > 0 ? 'text-marigold border-marigold/50' : 'text-muted-foreground'}"
    style="min-height:var(--tap)"
  >filter{#if active.length > 0}<span class="ml-1">{active.length}</span>{/if}</button>

  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
    {#each active as chip (chip.key)}
      <button
        onclick={chip.clear}
        aria-label="Remove filter {chip.label}"
        class="mono border-marigold/40 text-marigold hover:bg-inset inline-flex items-center gap-1 rounded-[6px] border px-1.5 text-[10px]"
        style="min-height:var(--tap)"
      >{chip.label} <span aria-hidden="true">×</span></button>
    {/each}
    {#if active.length > 1}
      <button
        onclick={() => (app.filters = { states: [], owners: [], minPriority: null, needsReview: false, live: false, overBudget: false })}
        class="text-muted-foreground hover:text-foreground mono text-[10px] underline underline-offset-2"
        style="min-height:var(--tap)"
      >clear all</button>
    {/if}
  </div>

  {#if open}
    <div class="bg-surface border-border absolute top-full left-0 z-30 mt-1 w-64 rounded-[10px] border p-3 shadow-2xl">
      <div class="eyebrow mb-1.5">state</div>
      <div class="flex flex-wrap gap-1">
        {#each states as s (s)}
          <button onclick={() => (app.filters.states = toggle(f.states, s))} aria-pressed={f.states.includes(s)}
            class="mono rounded-[5px] border px-1.5 text-[10px] {f.states.includes(s) ? 'border-marigold text-marigold' : 'border-border text-muted-foreground'}"
            style="min-height:var(--tap)">{s}</button>
        {/each}
      </div>

      <div class="eyebrow mt-3 mb-1.5">owner</div>
      <div class="flex flex-wrap gap-1">
        {#each owners as o (o)}
          <button onclick={() => (app.filters.owners = toggle(f.owners, o))} aria-pressed={f.owners.includes(o)}
            class="mono max-w-full truncate rounded-[5px] border px-1.5 text-[10px] {f.owners.includes(o) ? 'border-marigold text-marigold' : 'border-border text-muted-foreground'}"
            style="min-height:var(--tap)">{o}</button>
        {/each}
      </div>

      <label class="text-muted-foreground mono mt-3 flex items-center gap-2 text-[11px]">
        min priority
        <input type="number" min="0" value={f.minPriority ?? ''} placeholder="—"
          onchange={(e) => (app.filters.minPriority = e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
          class="bg-inset border-border focus:border-marigold w-14 rounded-[5px] border px-1.5 py-1" />
      </label>

      {#each [['needsReview', 'needs review'], ['live', 'an agent is working it'], ['overBudget', 'over budget']] as [key, label] (key)}
        <label class="text-muted-foreground mt-2 flex items-center gap-2 text-[11px]">
          <input type="checkbox" class="accent-marigold" checked={f[key as 'needsReview' | 'live' | 'overBudget']}
            onchange={(e) => (app.filters[key as 'needsReview' | 'live' | 'overBudget'] = e.currentTarget.checked)} />
          {label}
        </label>
      {/each}
    </div>
  {/if}
</div>

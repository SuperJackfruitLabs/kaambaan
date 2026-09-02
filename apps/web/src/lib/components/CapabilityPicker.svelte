<script lang="ts">
  import { capabilityTag } from '@kaambaan/contract';
  import type { CapabilityRecord } from '$lib/api';

  /**
   * Choose the capabilities an agent claims by.
   *
   * The options are the workspace's capability REGISTRY, not a hardcoded list and no longer just
   * one board's stage owners. Three values — research, review, publish — used to be hardcoded
   * here while the shipped templates defined stages needing code, test, deploy and triage, so an
   * agent could not be staffed to most of the templates the product ships with.
   *
   * A capability held by no board's stage is shown as such, because that is exactly the shape of
   * the bug that shipped: thirteen agents carrying `claim` — a token scope — matching no lane
   * anywhere. Free text still adds one, since a board may need a capability nobody has staffed.
   */
  let {
    selected = $bindable<string[]>([]),
    registry = [] as CapabilityRecord[],
    id = 'caps',
  }: { selected?: string[]; registry?: CapabilityRecord[]; id?: string } = $props();

  let custom = $state('');

  /** The SAME function the server and the stage editor use, so one capability has one spelling. */
  const normalise = capabilityTag;

  const byKey = $derived(new Map(registry.map((c) => [c.key, c])));
  const shown = $derived(
    [...new Set([...registry.map((c) => c.key), ...selected.map(normalise)])].filter(Boolean).sort(),
  );

  function toggle(cap: string): void {
    selected = selected.includes(cap) ? selected.filter((c) => c !== cap) : [...selected, cap];
  }

  function addCustom(): void {
    const v = normalise(custom);
    if (v === '') return;
    if (!selected.includes(v)) selected = [...selected, v];
    custom = '';
  }

  function hint(key: string): string {
    const c = byKey.get(key);
    if (!c) return 'new — no board asks for this yet';
    const parts = [c.description ?? c.name];
    if (c.boardCount === 0) parts.push('no board stage asks for this — an agent holding it can claim nothing');
    return parts.join(' · ');
  }
</script>

<div class="flex flex-wrap gap-1.5">
  {#each shown as cap (cap)}
    <button
      type="button"
      onclick={() => toggle(cap)}
      aria-pressed={selected.includes(cap)}
      title={hint(cap)}
      class="mono rounded-[6px] border px-2.5 py-1 text-[11px] transition {selected.includes(cap)
        ? 'border-marigold text-marigold'
        : 'border-border text-muted-foreground hover:text-foreground'}"
    >
      {selected.includes(cap) ? '✓ ' : ''}{cap}{#if byKey.get(cap)?.boardCount === 0}<span class="text-coral"> ·</span>{/if}
    </button>
  {/each}
  {#if shown.length === 0}
    <span class="text-muted-foreground text-[11px] leading-relaxed">
      This workspace knows no capabilities yet — add one below, or give a board stage an agent owner.
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

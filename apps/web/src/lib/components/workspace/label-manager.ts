/**
 * `LabelManager.svelte`'s mutations — kept out of the `.svelte` file for the same reason
 * `add-blocker.ts` is (this project's Vitest config cannot import a `.svelte` file).
 *
 * `createLabel`/`updateLabel`/`deleteLabel` (`$lib/api`) have been exported since Phase 1 with no
 * caller in this app at all — a label could be created by typing a name into a card and then never
 * renamed, recoloured or removed. These three are that caller.
 */

export interface LabelActionDeps {
  /** Same signature as `$lib/api`'s `updateLabel`. */
  updateLabel: (id: string, patch: { name?: string; colour?: string }) => Promise<Response>;
  /** Same signature as `$lib/api`'s `deleteLabel`. */
  deleteLabel: (id: string) => Promise<Response>;
}

export function renameLabel(deps: LabelActionDeps, id: string, name: string): Promise<Response> {
  return deps.updateLabel(id, { name: name.trim() });
}

export function recolourLabel(deps: LabelActionDeps, id: string, colour: string): Promise<Response> {
  return deps.updateLabel(id, { colour });
}

export function removeLabel(deps: LabelActionDeps, id: string): Promise<Response> {
  return deps.deleteLabel(id);
}

/**
 * Should this label's row carry the "inferred" badge? Same treatment `CapabilitiesTab.svelte`
 * already gives a capability's origin (`c.origin === 'inferred'`) — only the surprising case is
 * called out; `declared` is the unremarkable default and gets no badge of its own.
 */
export function showsInferredBadge(origin: 'declared' | 'inferred'): boolean {
  return origin === 'inferred';
}

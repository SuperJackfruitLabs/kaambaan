/**
 * Resolve a card's label ids to display names via the client's catalogue, and decide whether it
 * is safe to write `labelNames` back to the server from what resolved.
 *
 * Extracted from `CardDrawer.svelte` so it can be tested — same reason `board/card-due.ts` exists
 * beside `CardTile.svelte`; a `.svelte` file cannot be imported by a plain Vitest unit test in
 * this project's config.
 *
 * `card.labels` are ids; the free-text editor shows and edits NAMES, resolved through
 * `app.labelById()` (the catalogue loaded at board open). If that catalogue is stale — it used to
 * load only in `openBoard`, never on `refresh()` — or a `GET /v1/labels` merely failed (the API
 * client swallows a non-ok response and returns `[]`), an id on the card can resolve to nothing.
 * When that happens for EVERY id on a non-empty card, the editor cannot show what the card
 * actually carries, and saving must not be allowed to write `labelNames` at all: the text field
 * reads as empty, so an ordinary save (even a title-only edit — `saveCard` always sends
 * `labelNames`) would send `labelNames: []`, and the server reads an empty `labelNames` as
 * "replace with nothing" — silently wiping every label off the card. A UI that cannot see the
 * labels must not be able to delete them.
 */
export interface ResolvedCardLabelsForEdit {
  /** What the free-text input should show, comma-joined. */
  text: string;
  /** True when the card carries label ids but the catalogue resolved NONE of them by name. */
  blind: boolean;
}

export function resolveCardLabelsForEdit(labelIds: string[], nameById: Map<string, string>): ResolvedCardLabelsForEdit {
  const names = labelIds.map((id) => nameById.get(id)).filter((n): n is string => Boolean(n));
  return {
    text: names.join(', '),
    blind: labelIds.length > 0 && names.length === 0,
  };
}

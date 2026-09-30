/**
 * Pure predicates from `AppStore.filteredCards` (`app.svelte.ts`), extracted so they can be
 * tested: `app.svelte.ts` uses Svelte 5 runes (`$state`) and cannot be imported by a plain Vitest
 * unit test in this project's config (no `$lib` alias, no rune compilation outside SvelteKit) —
 * the same reason `card-due.ts` exists beside `CardTile.svelte`.
 */

/**
 * Should a card pass the "show archived" filter?
 *
 * `Card.archivedAt` (`packages/contract`) is `string | null`, but a card can also arrive with the
 * field genuinely absent — an optimistic local update, a partial snapshot, anything that built a
 * `Card`-shaped object without setting it. `c.archivedAt !== null` treats that `undefined` as "not
 * archived, so keep it visible only when NOT filtered" incorrectly: `undefined !== null` is `true`,
 * so an undated-archived card fails the `!f.showArchived && archivedAt !== null` check and gets
 * hidden even when it was never archived. `!archivedAt` treats `null` and `undefined` alike, which
 * is the only distinction that matters here — "has an archive date" vs. not.
 */
export function passesArchivedFilter(showArchived: boolean, archivedAt: string | null | undefined): boolean {
  if (showArchived) return true;
  return !archivedAt;
}

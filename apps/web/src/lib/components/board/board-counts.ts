/**
 * The per-stage blocked count (Task 17b, Step 2).
 *
 * Because a blocked card is EXCLUDED from the claim query rather than refused, an agent reports
 * "no work" while a human looking at the board sees cards sitting in a column doing nothing. The
 * stage header's `N blocked` count is the only place that exclusion is ever explained — not
 * optional polish.
 *
 * Counted from `blockedBy.length > 0`, the same field the tile's ⛔ badge reads — never a second
 * expression for "is this card blocked".
 */
export function blockedCountInStage(cards: Array<{ blockedBy: unknown[] }>): number {
  return cards.filter((c) => c.blockedBy.length > 0).length;
}

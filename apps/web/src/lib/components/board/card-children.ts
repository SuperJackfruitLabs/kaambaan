/**
 * The tile's sub-task fraction — open of total.
 *
 * `open` comes straight from `Card.openChildCount`, the same count `blockedWhere`'s
 * `openChildExists` clause excludes claims for (Task 14/17c) — never recomputed here from child
 * states, which would re-litigate what "resolved" means in a second place.
 *
 * `total` has no server field of its own (only the open count is tracked), so it is counted from
 * sibling cards' `parentCardId` — a structural fact (an edge exists), not a business-logic
 * derivation of which states count as done.
 */

export interface ChildCounter {
  open: number;
  total: number;
}

/**
 * Every card's child count, by parent id, built in ONE pass over the board's card list.
 *
 * Replaces a per-tile `cards.filter(c => c.parentCardId === cardId).length` (what this file used
 * to export as `countChildren`) — correct for one card, but called once per tile on a board with
 * many cards makes the whole render O(n²): every tile re-scans the full list the other tiles just
 * scanned. `BoardKanban` builds this Map ONCE per render and hands it down, the same fix the
 * server side already made with `rowToCard`'s `pre` argument (Task 14) and for the identical
 * reason — compute the shared fact once, not once per row that needs it.
 *
 * A card absent from the Map has zero children; callers read it with `.get(id) ?? 0`, never assume
 * every id is present (a Map entry for every childless card would just be noise).
 */
export function childCountsByParent(cards: Array<{ parentCardId: string | null }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of cards) {
    if (c.parentCardId === null) continue;
    counts.set(c.parentCardId, (counts.get(c.parentCardId) ?? 0) + 1);
  }
  return counts;
}

/** Null when the card has no children at all — a "0/0" badge would be noise, not information. */
export function childCounter(openChildCount: number, totalChildren: number): ChildCounter | null {
  if (totalChildren <= 0) return null;
  return { open: openChildCount, total: totalChildren };
}

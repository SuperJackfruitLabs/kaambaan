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

/** How many cards on the board name `cardId` as their parent. */
export function countChildren(cards: Array<{ parentCardId: string | null }>, cardId: string): number {
  return cards.filter((c) => c.parentCardId === cardId).length;
}

/** Null when the card has no children at all — a "0/0" badge would be noise, not information. */
export function childCounter(openChildCount: number, totalChildren: number): ChildCounter | null {
  if (totalChildren <= 0) return null;
  return { open: openChildCount, total: totalChildren };
}

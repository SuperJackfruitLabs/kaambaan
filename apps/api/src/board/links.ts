/**
 * Card-to-card edges: pure predicates, kept out of the Durable Object so they can be tested.
 */

export type LinkKind = 'blocks' | 'relates' | 'parent';

export interface LinkRow {
  fromCardId: string;
  toCardId: string;
  kind: LinkKind;
}

/** The kinds that impose an order, and can therefore deadlock. `relates` is decoration. */
const ORDERING: ReadonlySet<LinkKind> = new Set<LinkKind>(['blocks', 'parent']);

/**
 * Whether a blocker has been dealt with.
 *
 * **This is not `isTerminal()` and must never be replaced by it.** `TERMINAL_STATES` also contains
 * `rejected` and `failed`, and a blocker that failed is precisely the case where the dependent card
 * must stay blocked — otherwise the edge does nothing in the only situation anyone added it for.
 * There is a test asserting the two disagree, on purpose.
 *
 * This is the JS twin of `BoardDO.RESOLVED_SQL` (`board-do.ts`) — the SQL literal `('completed',
 * 'canceled')` interpolated into every card_links WHERE clause that asks this question. The SQL
 * copy is the live rule: every check in the DO today (`blockedWhere`, `openChildCount`,
 * `unresolvedBlockerCount`) is a WHERE clause, not a JS predicate, so this function is currently
 * unreferenced outside its own test. Keep both in sync if either changes, and prefer wiring this
 * one in rather than writing a third JS copy, if a genuine JS-side caller ever needs it.
 */
export function isResolved(state: string): boolean {
  return state === 'completed' || state === 'canceled';
}

/**
 * Would adding `candidate` close a loop among the ordering kinds?
 *
 * Breadth-first from the candidate's target back to its source, with a seen-set so an existing cycle
 * terminates the walk rather than hanging it — the same shape as `db/implications.ts`.
 */
export function wouldCycle(links: LinkRow[], candidate: LinkRow): boolean {
  if (!ORDERING.has(candidate.kind)) return false;
  if (candidate.fromCardId === candidate.toCardId) return true;

  const out = new Map<string, string[]>();
  for (const l of links) {
    if (!ORDERING.has(l.kind)) continue;
    const list = out.get(l.fromCardId);
    if (list) list.push(l.toCardId);
    else out.set(l.fromCardId, [l.toCardId]);
  }

  const seen = new Set<string>();
  const queue = [candidate.toCardId];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === candidate.fromCardId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of out.get(node) ?? []) queue.push(next);
  }
  return false;
}

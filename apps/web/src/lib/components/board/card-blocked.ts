/**
 * Two badges, never one (Task 17b, Step 1).
 *
 * An enforced blocker (same-board `blocks`, unresolved — the claim query's own predicate,
 * `Card.blockedBy`, Task 17c) and an advisory one (cross-board, Task 16 — shown, never enforced)
 * must never share a glyph or a colour. A single badge covering both would sometimes lie about
 * whether the card will actually be claimed, and a badge that sometimes lies is worse than two
 * honest badges.
 *
 * `enforcedBadge` is built ONLY from `Card.blockedBy` — never re-derived from links, state, or
 * anything else. That field is already the server's own claim-query predicate; a badge computed
 * independently of it is a badge that can eventually disagree with `claim_card`.
 */

export interface BlockedBadge {
  glyph: '⛔' | '⚑';
  label: string;
  tooltip: string;
}

export interface EnforcedBlocker {
  cardId: string;
  title: string;
}

/** The ⛔ badge, or null when `blockedBy` is empty — a card with only open children is not blocked. */
export function enforcedBadge(blockedBy: EnforcedBlocker[]): BlockedBadge | null {
  if (blockedBy.length === 0) return null;
  const [first, ...rest] = blockedBy;
  const who = rest.length > 0 ? `${first!.title} and ${rest.length} other${rest.length === 1 ? '' : 's'}` : first!.title;
  return {
    glyph: '⛔',
    label: 'Blocked',
    tooltip: `Blocked by ${who} — this card will not be claimed`,
  };
}

/**
 * The ⚑ badge for one cross-board advisory blocker. Never `⛔` — nothing enforces this edge, the
 * claim query on this board cannot see another board's rows at all.
 */
export function advisoryBadge(boardName: string | null): BlockedBadge {
  const onBoard = boardName ? ` on ${boardName}` : '';
  return {
    glyph: '⚑',
    label: 'Blocked (advisory)',
    tooltip: `Blocked${onBoard} — not enforced across boards`,
  };
}

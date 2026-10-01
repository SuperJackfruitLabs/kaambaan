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
 *
 * `title` is a plain string, not `string | null` — the null case (the server could not resolve the
 * other card's title, `GET .../links`'s `otherCardTitle`) is a real state, but it is
 * `link-groups.ts#buildLinkGroups`' job to decide the fallback (the card id), not this function's.
 * By the time a title reaches here it is always something to show; `advisoryBadge` cannot tell a
 * real title from an id and does not need to — either way the tooltip reads as one full sentence,
 * never "Blocked by  on Board".
 */
export function advisoryBadge(title: string, boardName: string | null): BlockedBadge {
  const onBoard = boardName ? ` on ${boardName}` : '';
  return {
    glyph: '⚑',
    label: 'Blocked (advisory)',
    tooltip: `Blocked by ${title}${onBoard} — not enforced across boards`,
  };
}

/**
 * The drawer's Blockers section: one row per blocker, each carrying its own honest badge.
 *
 * Enforced rows come straight from `Card.blockedBy` (same field the tile's badge reads — one
 * spelling of "is this card blocked", never a second one built from links). Advisory rows come
 * from the cross-board `externalLinks` half of `GET .../cards/:cardId/links` (Task 16/17d),
 * filtered to `kind === 'blocks'` edges that point AT this card — the edges that name this card as
 * blocked, not the ones this card names as blocking something else.
 *
 * The two never merge into one list with one glyph: each row's badge comes from
 * `enforcedBadge`/`advisoryBadge` (`./board/card-blocked`), so a row can never accidentally borrow
 * the other kind's colour or claim.
 */
import { enforcedBadge, advisoryBadge, type BlockedBadge, type EnforcedBlocker } from './board/card-blocked';

export interface BlockerRow {
  cardId: string;
  /** null for a same-board (enforced) blocker; the foreign board id for an advisory one. */
  boardId: string | null;
  /** The blocker's title, when known — `Card.blockedBy` always carries one; an advisory row may not. */
  title: string | null;
  badge: BlockedBadge;
}

export interface ExternalBlockerLike {
  kind: string;
  toCardId: string;
  fromCardId: string;
  fromBoardId: string;
}

export function blockerRows(
  cardId: string,
  blockedBy: EnforcedBlocker[],
  externalLinks: ExternalBlockerLike[],
  boardName: (boardId: string) => string | null,
): BlockerRow[] {
  const enforced: BlockerRow[] = blockedBy.map((b) => ({
    cardId: b.cardId,
    boardId: null,
    title: b.title,
    badge: enforcedBadge([b])!,
  }));

  const advisory: BlockerRow[] = externalLinks
    .filter((l) => l.kind === 'blocks' && l.toCardId === cardId)
    .map((l) => ({
      cardId: l.fromCardId,
      boardId: l.fromBoardId,
      title: null,
      badge: advisoryBadge(boardName(l.fromBoardId)),
    }));

  return [...enforced, ...advisory];
}

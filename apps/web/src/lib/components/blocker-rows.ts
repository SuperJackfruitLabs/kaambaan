/**
 * The drawer's Blockers section: one row per blocker, each carrying its own honest badge.
 *
 * Enforced rows come straight from `Card.blockedBy` (same field the tile's badge reads — one
 * spelling of "is this card blocked", never a second one built from links). Advisory rows come
 * from the cross-board `externalLinks` half of `GET .../cards/:cardId/links` (Task 16/17d),
 * filtered to `kind === 'blocks'` edges that point AT this card — the edges that name this card as
 * blocked, not the ones this card names as blocking something else.
 *
 * `otherCardTitle`/`otherBoardName` (17b follow-up) are resolved server-side, per row, by the same
 * route — never re-fetched or re-derived here. Either can be `null` (the other board is
 * unavailable, the card is gone, or it belongs to another tenant) as a real, expected state, not an
 * error: the fallback to the card id happens HERE, once, so both the visible row text and the
 * badge's tooltip agree on the same fallback rather than disagreeing about what to show.
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
  /** The blocker's title — a real one for an enforced row, real-or-id for an advisory one; never null. */
  title: string;
  badge: BlockedBadge;
}

export interface ExternalBlockerLike {
  kind: string;
  toCardId: string;
  fromCardId: string;
  fromBoardId: string;
  /** The other end's card title, resolved server-side — null when it could not be read. */
  otherCardTitle: string | null;
  /** The other end's board name, resolved server-side — null when it could not be read. */
  otherBoardName: string | null;
}

export function blockerRows(cardId: string, blockedBy: EnforcedBlocker[], externalLinks: ExternalBlockerLike[]): BlockerRow[] {
  const enforced: BlockerRow[] = blockedBy.map((b) => ({
    cardId: b.cardId,
    boardId: null,
    title: b.title,
    badge: enforcedBadge([b])!,
  }));

  const advisory: BlockerRow[] = externalLinks
    .filter((l) => l.kind === 'blocks' && l.toCardId === cardId)
    .map((l) => {
      // The fallback lives here, once, so the row's visible label and its tooltip can never
      // disagree about what stands in for a title the server could not resolve.
      const title = l.otherCardTitle ?? l.fromCardId;
      return {
        cardId: l.fromCardId,
        boardId: l.fromBoardId,
        title,
        badge: advisoryBadge(title, l.otherBoardName),
      };
    });

  return [...enforced, ...advisory];
}

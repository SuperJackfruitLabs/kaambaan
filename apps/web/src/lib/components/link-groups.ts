/**
 * Every edge a card has, grouped so the meanings stay distinct (Phase 3 whole-branch review,
 * Important finding): a person could create a `relates` edge, or an outgoing `blocks` edge, and
 * the web app would render it NOWHERE — no error, no row, no way to know the edge existed, let
 * alone remove it. That is the write-surface defect this plan has hit repeatedly, this time in the
 * mirror direction (something creatable that renders nowhere, rather than something visible with
 * no way to create it).
 *
 * Four groups, one edge in exactly one of them:
 *  - `blockedBy` — same-board `blocks`, unresolved, pointing AT this card. The ONLY group allowed
 *    to say `⛔` — sourced from `Card.blockedBy`, never re-derived, same as `card-blocked.ts`.
 *  - `blocks` — same-board `blocks` pointing FROM this card. Blocks the OTHER card, not this one;
 *    no enforcement language belongs on a row describing what THIS card does to something else.
 *  - `relates` — same-board `relates`, either direction. Informational only, by construction
 *    (`links.ts` — a `relates` edge is not consulted anywhere `blockedWhere` looks).
 *  - `advisory` — every cross-board edge touching this card, any kind, either direction, in ONE
 *    group (nothing here is enforced, regardless of kind). Within it, only the subset that is a
 *    `blocks` edge pointing AT this card may render the `⚑ Blocked (advisory)` badge — anything
 *    else in this group saying "Blocked" would be exactly the kind of badge that sometimes lies
 *    this whole design exists to prevent.
 *
 * `parent` edges are deliberately absent from all four groups — they are the Sub-tasks section's
 * concern (`CardDrawer`'s `children`, sourced from `parentCardId`), not this one's.
 */
import { enforcedBadge, advisoryBadge, type BlockedBadge, type EnforcedBlocker } from './board/card-blocked';

export type EdgeKind = 'blocks' | 'relates';

/** Exactly the argument tuple `removeLink(boardId, fromCardId, toCardId, kind, toBoardId?)` takes. */
export interface RemoveArgs {
  boardId: string;
  fromCardId: string;
  toCardId: string;
  kind: EdgeKind;
  toBoardId?: string;
}

export interface BlockedByRow {
  cardId: string;
  title: string;
  badge: BlockedBadge;
  remove: RemoveArgs;
}

export interface EdgeRow {
  cardId: string;
  title: string;
  kind: EdgeKind;
  remove: RemoveArgs;
}

export interface AdvisoryRow {
  cardId: string;
  boardId: string;
  title: string;
  kind: EdgeKind;
  /** This row's relationship to the requested card — 'blocked-by' is the only one that may badge. */
  relation: 'blocked-by' | 'blocks' | 'relates';
  badge: BlockedBadge | null;
  remove: RemoveArgs;
}

export interface LinkGroups {
  blockedBy: BlockedByRow[];
  blocks: EdgeRow[];
  relates: EdgeRow[];
  advisory: AdvisoryRow[];
}

interface SameBoardLinkLike {
  fromCardId: string;
  toCardId: string;
  kind: string; // 'blocks' | 'relates' | 'parent' — only the first two are grouped here
}

interface ExternalLinkLike {
  fromBoardId: string;
  fromCardId: string;
  toBoardId: string;
  toCardId: string;
  kind: EdgeKind;
  otherCardTitle: string | null;
  otherBoardName: string | null;
}

export function buildLinkGroups(
  boardId: string,
  cardId: string,
  blockedBy: EnforcedBlocker[],
  links: SameBoardLinkLike[],
  externalLinks: ExternalLinkLike[],
  /** Same-board title lookup — the client already has every same-board card loaded. */
  titleOf: (otherCardId: string) => string,
): LinkGroups {
  const blockedByRows: BlockedByRow[] = blockedBy.map((b) => ({
    cardId: b.cardId,
    title: b.title,
    badge: enforcedBadge([b])!,
    remove: { boardId, fromCardId: b.cardId, toCardId: cardId, kind: 'blocks' },
  }));

  const blocks: EdgeRow[] = links
    .filter((l): l is SameBoardLinkLike & { kind: 'blocks' } => l.kind === 'blocks' && l.fromCardId === cardId)
    .map((l) => ({
      cardId: l.toCardId,
      title: titleOf(l.toCardId),
      kind: 'blocks',
      remove: { boardId, fromCardId: l.fromCardId, toCardId: l.toCardId, kind: 'blocks' },
    }));

  const relates: EdgeRow[] = links
    .filter((l) => l.kind === 'relates')
    .map((l) => {
      const otherId = l.fromCardId === cardId ? l.toCardId : l.fromCardId;
      return {
        cardId: otherId,
        title: titleOf(otherId),
        kind: 'relates' as const,
        remove: { boardId, fromCardId: l.fromCardId, toCardId: l.toCardId, kind: 'relates' as const },
      };
    });

  const advisory: AdvisoryRow[] = externalLinks.map((l) => {
    const thisIsFrom = l.fromCardId === cardId;
    const otherCardId = thisIsFrom ? l.toCardId : l.fromCardId;
    const otherBoardId = thisIsFrom ? l.toBoardId : l.fromBoardId;
    const title = l.otherCardTitle ?? otherCardId;
    const relation: AdvisoryRow['relation'] = l.kind === 'relates' ? 'relates' : thisIsFrom ? 'blocks' : 'blocked-by';
    return {
      cardId: otherCardId,
      boardId: otherBoardId,
      title,
      kind: l.kind,
      relation,
      // ONLY 'blocked-by' may badge — the one advisory shape that actually says something is
      // blocking THIS card. Everything else in this group stays badge-free by construction.
      badge: relation === 'blocked-by' ? advisoryBadge(title, l.otherBoardName) : null,
      remove: { boardId: l.fromBoardId, fromCardId: l.fromCardId, toCardId: l.toCardId, kind: l.kind, toBoardId: l.toBoardId },
    };
  });

  return { blockedBy: blockedByRows, blocks, relates, advisory };
}

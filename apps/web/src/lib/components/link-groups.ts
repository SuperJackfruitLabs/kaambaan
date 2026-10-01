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
 *
 * A FIFTH group, `resolvedBlockedBy` (re-review finding N2): `blockedBy` only ever carries
 * UNRESOLVED inbound `blocks` edges (server-computed, by design — it is the claim query's own
 * predicate). `links` carries the edge regardless of resolution, since nothing ever deletes it
 * once its blocker completes. A resolved inbound blocker therefore used to land in NO group at
 * all — in `links`, but neither `blockedBy` (wrong resolution state) nor `blocks` (wrong
 * direction — that group is outgoing only) — the exact "creatable, invisible, unremovable" defect
 * this whole review exists to close, just for a subset one `git blame` deeper. Dormant, not dead:
 * `moveCard` sets a card back to `submitted` unconditionally on a re-open, so pulling a completed
 * blocker back for rework silently re-arms an edge its owner never saw and had no way to clear.
 * Shown as resolved, never `⛔` — the group's whole existence is to be honest that nothing here is
 * currently enforcing anything, while still making the edge visible and removable.
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

/**
 * A stable key for ONE EDGE — never for the other card it names.
 *
 * Two edges between the same pair of cards are not a hypothetical: `wouldCycle` (`links.ts`)
 * deliberately excludes `relates` from its cycle check, and `addExternalLink` has no cycle check
 * at all, so `A relates B` and `B relates A` can both exist, created through the very dialogue
 * this drawer ships (add each as the other's `relates` link). From either card's own drawer, BOTH
 * rows resolve to the same "other card" — a `{#each}` key built from that id alone then produces
 * the same key for two different rows, and Svelte 5 THROWS `each_key_duplicate` on a repeated key,
 * which fails the whole drawer's render rather than merely mis-rendering one row. No test in this
 * project can catch a duplicate-key crash directly (Vitest cannot import a `.svelte` file here),
 * so this comment is the enforcement: any `{#each}` over a `LinkGroups` array MUST key its rows by
 * `edgeKey(row.remove)`, never by `row.cardId` or `row.boardId` alone — `remove` already carries
 * the edge's own identity (the exact tuple `removeLink` is called with), so reading the key from
 * it, rather than recomputing a second expression, is what keeps the two from drifting apart.
 */
export function edgeKey(remove: RemoveArgs): string {
  return remove.toBoardId
    ? `${remove.boardId}:${remove.fromCardId}:${remove.toCardId}:${remove.kind}:${remove.toBoardId}`
    : `${remove.boardId}:${remove.fromCardId}:${remove.toCardId}:${remove.kind}`;
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
  /** Inbound same-board `blocks` edges whose blocker has already resolved — visible, removable, never ⛔. */
  resolvedBlockedBy: EdgeRow[];
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

  // The complement of `blockedBy` within "inbound `blocks` edges" — never re-derived from card
  // state (no reading of the blocker's own `state` here): `blockedBy` already IS the unresolved
  // subset, computed server-side from the same predicate the claim query uses, so "not in that
  // set" is the honest, non-redundant way to find the resolved remainder.
  const blockedByIds = new Set(blockedBy.map((b) => b.cardId));
  const resolvedBlockedBy: EdgeRow[] = links
    .filter((l): l is SameBoardLinkLike & { kind: 'blocks' } => l.kind === 'blocks' && l.toCardId === cardId && !blockedByIds.has(l.fromCardId))
    .map((l) => ({
      cardId: l.fromCardId,
      title: titleOf(l.fromCardId),
      kind: 'blocks',
      remove: { boardId, fromCardId: l.fromCardId, toCardId: l.toCardId, kind: 'blocks' },
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

  return { blockedBy: blockedByRows, resolvedBlockedBy, blocks, relates, advisory };
}

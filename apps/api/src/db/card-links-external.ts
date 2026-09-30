/**
 * Cross-board card edges (migration 0012) — ADVISORY, always.
 *
 * Same-board edges live in the board Durable Object's `card_links`, where the claim path reads them
 * and they can actually refuse a claim. These cannot be: the two ends are in two different DOs, so
 * any enforcement would rest on a cross-DO read that is stale the moment it returns. They exist to
 * be SHOWN, and the UI must say so before an edge is created, not after.
 */
export type ExternalLinkKind = 'blocks' | 'relates';
export interface ExternalEnd { boardId: string; cardId: string }
export interface ExternalLinkRow { fromBoardId: string; fromCardId: string; toBoardId: string; toCardId: string; kind: ExternalLinkKind }

const COLUMNS =
  'from_board_id AS fromBoardId, from_card_id AS fromCardId, to_board_id AS toBoardId, to_card_id AS toCardId, kind';

export type AddResult = { ok: true } | { ok: false; code: string; message: string };

export async function addExternalLink(
  db: D1Database,
  tenantId: string,
  edge: { from: ExternalEnd; to: ExternalEnd; kind: ExternalLinkKind },
): Promise<AddResult> {
  if (edge.kind === ('parent' as string)) {
    return { ok: false, code: 'PARENT_MUST_BE_SAME_BOARD', message:
      'A parent edge carries a rule — a parent does not advance while a child is open — and an advisory containment relationship is one that fails to contain. Use a project to group cards across boards.' };
  }
  if (edge.kind !== 'blocks' && edge.kind !== 'relates') {
    return { ok: false, code: 'BAD_KIND', message: `kind must be 'blocks' or 'relates', got '${edge.kind}'` };
  }
  if (edge.from.boardId === edge.to.boardId) {
    return { ok: false, code: 'SAME_BOARD_EDGE', message:
      'Both cards are on the same board, so this edge belongs in the board\'s own card_links where it is enforced. Storing it here would show a badge that refuses nothing.' };
  }
  if (edge.from.cardId === edge.to.cardId) {
    return { ok: false, code: 'SELF_EDGE', message:
      'A card cannot link to itself — an edge is a relationship between two cards, and there is no alternative form of this one to store; it is simply not a fact.' };
  }
  // Both boards must exist AND belong to this tenant. One query, so a caller naming a board it
  // cannot see is refused identically to one naming a board that does not exist.
  const owned = await db
    .prepare(`SELECT COUNT(*) AS n FROM boards WHERE tenant_id = ? AND id IN (?, ?)`)
    .bind(tenantId, edge.from.boardId, edge.to.boardId)
    .first<{ n: number }>();
  if ((owned?.n ?? 0) !== 2) {
    return { ok: false, code: 'FOREIGN_BOARD', message: 'Both boards must exist and belong to this tenant.' };
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO card_links_external
         (tenant_id, from_board_id, from_card_id, to_board_id, to_card_id, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(tenantId, edge.from.boardId, edge.from.cardId, edge.to.boardId, edge.to.cardId, edge.kind)
    .run();
  return { ok: true };
}

/** Every advisory edge touching this card, from EITHER end. Tenant-scoped, like every D1 read. */
export async function listExternalLinksFor(
  db: D1Database,
  tenantId: string,
  cardId: string,
): Promise<ExternalLinkRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM card_links_external WHERE tenant_id = ? AND (from_card_id = ? OR to_card_id = ?)`)
    .bind(tenantId, cardId, cardId)
    .all<ExternalLinkRow>();
  return results ?? [];
}

export async function removeExternalLink(
  db: D1Database,
  tenantId: string,
  fromCardId: string,
  toCardId: string,
  kind: ExternalLinkKind,
): Promise<void> {
  // Matches on (from_card_id, to_card_id, kind) alone — the board ids are not part of the WHERE.
  // That is only safe because card ids are globally unique (`newId('card')`, `ids.ts`), never
  // board-scoped, so a (fromCardId, toCardId, kind) triple names at most one row regardless of
  // which boards are passed in. If card ids ever become board-scoped, this needs from_board_id and
  // to_board_id added to the match, or a caller could remove an edge for the wrong pair of boards.
  await db
    .prepare(`DELETE FROM card_links_external WHERE tenant_id = ? AND from_card_id = ? AND to_card_id = ? AND kind = ?`)
    .bind(tenantId, fromCardId, toCardId, kind)
    .run();
}

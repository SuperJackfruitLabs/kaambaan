import type { Env } from './env';
import { boardStub } from './board/stub';
import type { BoardStub } from './board/board-do';
import { listExternalLinksFor } from './db/card-links-external';

/**
 * Names for the boards in `boardIds`, but ONLY the ones `tenantId` actually owns — a board id that
 * names another tenant's board, or no board at all, simply has no entry in the returned map.
 *
 * This is the read-side guard for `GET .../cards/:cardId/links`'s `otherBoardName`: a cross-board
 * advisory row's write is already checked against `FOREIGN_BOARD` (`addExternalLink`), but this
 * read must not assume every row in `card_links_external` got there through that guard — a title
 * is content, and resolving one for a board outside the tenant would disclose more than the 404
 * that guard answers with. `tenant_id = ?` first, like every other D1 read in this codebase.
 */
export async function boardNamesById(db: D1Database, tenantId: string, boardIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(boardIds)];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT id, name FROM boards WHERE tenant_id = ? AND id IN (${placeholders})`)
    .bind(tenantId, ...ids)
    .all<{ id: string; name: string }>();
  return new Map((results ?? []).map((row) => [row.id, row.name]));
}

/**
 * The title of one card on another board, for one advisory edge's tooltip — or `null` if it
 * cannot be read, for any reason. This is the one place a cross-DO read happens for a cross-board
 * edge, and it is deliberately narrow: on-demand, per row, called only from the `GET .../links`
 * route, never from `listExternalLinksFor` (the D1 module stays free of cross-DO concerns) and
 * never consulted by a claim or advance decision — the read is stale the instant it returns, which
 * is exactly why the edge it labels is advisory rather than enforced, and that does not change
 * just because this read is now a little more informative than an id.
 *
 * Degrades rather than fails: an uninitialized board, a deleted card, or a thrown error (the DO
 * being genuinely unavailable) all come back `null`, wrapped PER CALL so one bad reference cannot
 * take the rest of a card's blocker list down with it — a 500 here would be a worse outcome than
 * the id the drawer already falls back to showing.
 *
 * Callers must already have confirmed `boardId` belongs to `tenantId` (see `boardNamesById`); this
 * function does not check tenancy itself, so it must never be reached for a foreign board.
 */
async function getOtherCardTitle(env: Env, tenantId: string, boardId: string, cardId: string): Promise<string | null> {
  try {
    const result = await boardStub(env, tenantId, boardId).getCardView(cardId);
    return result.ok ? result.value.title : null;
  } catch {
    return null;
  }
}

/**
 * The body of `GET /v1/boards/:id/cards/:cardId/links`: every edge touching a card, from both stores.
 * One builder for the human route and the service route, so a consumer sees one shape whoever asks.
 */
export async function cardLinksBody(env: Env, tenantId: string, stub: BoardStub, cardId: string) {
      const [links, externalLinks] = await Promise.all([
        stub.listLinks(cardId),
        listExternalLinksFor(env.DB, tenantId, cardId),
      ]);

      // The other end of each advisory edge — `listExternalLinksFor` matches `cardId` from
      // EITHER side, so which field holds "the other card" depends on the row's direction.
      const otherEnds = externalLinks.map((l) =>
        l.fromCardId === cardId
          ? { boardId: l.toBoardId, cardId: l.toCardId }
          : { boardId: l.fromBoardId, cardId: l.fromCardId },
      );
      // Tenant-scoped by the WHERE clause itself: a board this tenant does not own is simply
      // absent from the map. That is deliberate defence in depth, not redundant with
      // `addExternalLink`'s own `FOREIGN_BOARD` guard at write time — this read must not assume
      // every row in the table got there through that guard. Boards not owned by the tenant, or
      // no longer present at all, degrade to `otherBoardName: null` the same way an unresolved
      // title does, never a leak or a failure.
      const boardNames = await boardNamesById(env.DB, tenantId, otherEnds.map((e) => e.boardId));
      // One on-demand, per-row cross-DO read per advisory edge, run in parallel rather than
      // sequentially — not batched into a single multi-card DO call. Considered and rejected for
      // now: these rows are hand-added one at a time through a board-picker dialogue, so the
      // realistic count for one card is a handful at most, and rows just as often name DIFFERENT
      // boards (nothing to batch within) as the same one. A batched "read several cards" RPC
      // would mean a new Durable Object method, which is out of this route's scope. Skipped
      // entirely — no DO call at all — for any end whose board did not resolve above, so a
      // foreign board is never even asked, not just never shown.
      const otherTitles = await Promise.all(
        otherEnds.map((e) => (boardNames.has(e.boardId) ? getOtherCardTitle(env, tenantId, e.boardId, e.cardId) : null)),
      );

      return {
        // `enforced` must mean what it says: true only for a same-board edge that can actually
        // refuse a claim. `blockedWhere` has two clauses — an unresolved `blocks` edge pointing
        // AT a card, and an open child (`parent`) pointing FROM one — so both `blocks` and
        // `parent` genuinely enforce something; `relates` is decoration, consulted nowhere.
        // Stamping every kind `true` unconditionally told a client a `relates` edge refuses a
        // claim it does not — unreachable today only because of a web-side defect being fixed
        // separately, and the whole point of this flag is that a client should never have to
        // infer enforcement itself, including for the one kind that has none.
        links: links.map((l) => ({ ...l, enforced: l.kind === 'blocks' || l.kind === 'parent' })),
        externalLinks: externalLinks.map((l, i) => ({
          ...l,
          enforced: false as const,
          otherBoardName: boardNames.get(otherEnds[i]!.boardId) ?? null,
          otherCardTitle: otherTitles[i] ?? null,
        })),
      };
}

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

/**
 * One-shot backfill for the orphans the archive bug left behind: pending gates and questions that
 * belong to cards already archived. Runs once per board (meta flag), touches nothing else.
 */
const REVIEW: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
];
const ASKING: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
];
const ARCHIVED = '2026-10-10T08:00:00.000Z';

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

/** Create a card and drive it onto the review gate. */
async function cardAtReview(board: BoardDO, title: string): Promise<string> {
  const card = await board.createCard({ title, ownerUserId: 'usr_a' });
  if (!card.ok) throw new Error(card.message);
  const c = await board.claim({ agentId: 'agt_r', capabilities: ['research', 'writing'] });
  if (!c.claimed) throw new Error('expected a claim');
  const done = await board.complete({
    runId: c.runId, leaseEpoch: c.leaseEpoch,
    handoff: { summary: 'drafted' },
  });
  if (!done.ok) throw new Error(done.message);
  return card.value.id;
}

const pendingFor = async (board: BoardDO, cardId: string) =>
  (await board.getState()).gates.filter((g) => g.cardId === cardId && g.status === 'pending');
/** The stored status, not the read shape: the reads hide an archived card's gates by design. */
const rawStatus = (state: DurableObjectState, table: 'gates' | 'elicitations', cardId: string): string[] =>
  state.storage.sql.exec(`SELECT status FROM ${table} WHERE card_id = ?`, cardId).toArray().map((r) => r.status as string);

describe('orphans: gates left pending by archives before this fix', () => {
  async function seed(board: BoardDO, state: DurableObjectState) {
    await board.init({ id: 'brd_bf', tenantId: 'tnt_a', name: 'B', stages: REVIEW });
    const archived = await cardAtReview(board, 'archived');
    const live = await cardAtReview(board, 'live');
    // Reproduce the pre-fix archive: the column set, nothing cancelled.
    state.storage.sql.exec(`UPDATE cards SET archived_at = ? WHERE id = ?`, ARCHIVED, archived);
    state.storage.sql.exec(`DELETE FROM meta WHERE k = 'archivedReviewsBackfillDone'`);
    return { archived, live };
  }

  it('cancels only the archived cards\' pending gates', async () => {
    await runInDurableObject(stubFor('bf-1'), async (board: BoardDO, state) => {
      const { archived, live } = await seed(board, state);
      expect(rawStatus(state, 'gates', archived)).toEqual(['pending']);
      await board.sweepBoard('2026-10-10T09:00:00.000Z');
      expect(rawStatus(state, 'gates', archived)).toEqual(['cancelled']);
      expect(await pendingFor(board, live)).toHaveLength(1);
      expect(await board.pendingGateDeliveries()).toHaveLength(1);
    });
  });

  it('runs once: a second sweep changes nothing', async () => {
    await runInDurableObject(stubFor('bf-2'), async (board: BoardDO, state) => {
      const { archived } = await seed(board, state);
      await board.sweepBoard('2026-10-10T09:00:00.000Z');
      const sql = state.storage.sql;
      const first = sql.exec(`SELECT id, status, resolved_at FROM gates WHERE card_id = ?`, archived).toArray();
      await board.sweepBoard('2026-10-10T10:00:00.000Z');
      expect(sql.exec(`SELECT id, status, resolved_at FROM gates WHERE card_id = ?`, archived).toArray()).toEqual(first);
      expect(sql.exec(`SELECT v FROM meta WHERE k = 'archivedReviewsBackfillDone'`).one().v).toBe('1');
    });
  });

  it('cancels an archived card\'s pending question too', async () => {
    await runInDurableObject(stubFor('bf-3'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_bq', tenantId: 'tnt_a', name: 'Q', stages: ASKING });
      const card = await board.createCard({ title: 'Q', ownerUserId: 'usr_a' });
      if (!card.ok) throw new Error(card.message);
      const c = await board.claim({ agentId: 'agt_r', capabilities: ['research'] });
      if (!c.claimed) throw new Error('claim');
      await board.postActivity({
        runId: c.runId, leaseEpoch: c.leaseEpoch, agentId: 'agt_r', type: 'elicitation',
        body: 'May I?', signal: 'select', parameter: { options: [{ name: 'y', title: 'Yes' }] } as never,
      });
      state.storage.sql.exec(`UPDATE cards SET archived_at = ? WHERE id = ?`, ARCHIVED, card.value.id);
      state.storage.sql.exec(`DELETE FROM meta WHERE k = 'archivedReviewsBackfillDone'`);
      expect(rawStatus(state, 'elicitations', card.value.id)).toEqual(['pending']);
      await board.sweepBoard('2026-10-10T09:00:00.000Z');
      expect(rawStatus(state, 'elicitations', card.value.id)).toEqual(['cancelled']);
    });
  });
});

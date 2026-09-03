import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

/**
 * A stage may require a SET of capabilities, not just one.
 *
 * Routing stays exact string equality on every member — the point of the set is expressiveness,
 * not fuzziness. A lane that needs someone who can both write code and assess security could not
 * be expressed at all before this, and the workaround (one capability named `code-security`) is
 * how vocabularies fragment.
 */
const PIPE: BoardInit['stages'] = [
  { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
  { key: 'audit', name: 'Audit', order: 1, ownerKind: 'capability', requires: { all: ['code', 'security'] } },
  { key: 'impl', name: 'Implement', order: 2, ownerKind: 'capability', requires: { any: ['python', 'typescript'] } },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function boardWithCardIn(board: BoardDO, stageKey: string, id: string): Promise<void> {
  await board.init({ id, tenantId: 'tnt_a', name: 'R', stages: PIPE });
  const card = await board.createCard({ title: 'A card', ownerUserId: 'usr_a' });
  if (!card.ok) throw new Error('card');
  const moved = await board.moveCard(card.value.id, stageKey);
  if (!moved.ok) throw new Error(`move: ${moved.code}`);
}

describe('BoardDO — a stage that requires a set', () => {
  it('`all` refuses an agent holding only part of it, and admits one holding all', async () => {
    await runInDurableObject(stubFor('req-all'), async (board: BoardDO) => {
      await boardWithCardIn(board, 'audit', 'brd_all');

      // Holds one of the two required. This is the case a single-string owner could not express:
      // before, the lane would have said `code` and this agent would have taken security work.
      expect((await board.claim({ agentId: 'agt_partial', capabilities: ['code'] })).claimed).toBe(false);
      expect((await board.claim({ agentId: 'agt_both', capabilities: ['code', 'security'] })).claimed).toBe(true);
    });
  });

  it('`any` admits an agent holding either member', async () => {
    await runInDurableObject(stubFor('req-any'), async (board: BoardDO) => {
      await boardWithCardIn(board, 'impl', 'brd_any');
      expect((await board.claim({ agentId: 'agt_ts', capabilities: ['typescript'] })).claimed).toBe(true);
    });
  });

  it('`any` refuses an agent holding neither', async () => {
    await runInDurableObject(stubFor('req-any-no'), async (board: BoardDO) => {
      await boardWithCardIn(board, 'impl', 'brd_any2');
      expect((await board.claim({ agentId: 'agt_go', capabilities: ['go'] })).claimed).toBe(false);
    });
  });

  it('countReadyForCapabilities agrees with claim, so discovery cannot promise work that refuses', async () => {
    await runInDurableObject(stubFor('req-count'), async (board: BoardDO) => {
      await boardWithCardIn(board, 'audit', 'brd_count');
      // The MCP list_work surface and the claim predicate must never disagree: an agent told it
      // has work and then refused it would retry forever.
      expect(await board.countReadyForCapabilities('agt_partial', ['code'])).toBe(0);
      expect(await board.countReadyForCapabilities('agt_both', ['code', 'security'])).toBe(1);
    });
  });

  it('normalises every member on init, because routing is exact equality', async () => {
    await runInDurableObject(stubFor('req-norm'), async (board: BoardDO) => {
      const snap = await board.init({
        id: 'brd_norm',
        tenantId: 'tnt_a',
        name: 'N',
        stages: [
          { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
          { key: 'a', name: 'A', order: 1, ownerKind: 'capability', requires: { all: ['Code Review', 'SECURITY'] } },
        ],
      });
      const stage = snap.stages.find((s) => s.key === 'a');
      expect(stage?.requires).toEqual({ all: ['code-review', 'security'] });

      // And an agent typing it the human way still matches, which is the whole point.
      const card = await board.createCard({ title: 'x', ownerUserId: 'usr_a' });
      if (!card.ok) throw new Error('card');
      await board.moveCard(card.value.id, 'a');
      expect(
        (await board.claim({ agentId: 'agt_n', capabilities: ['code-review', 'security'] })).claimed,
      ).toBe(true);
    });
  });

  it('an empty requirement falls back to owner rather than blocking the lane', async () => {
    await runInDurableObject(stubFor('req-empty'), async (board: BoardDO) => {
      // A stray `{}` from an editor must not silently create a lane nobody can work — that is the
      // exact failure mode this whole area exists to end.
      await board.init({
        id: 'brd_empty',
        tenantId: 'tnt_a',
        name: 'E',
        stages: [
          { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
          { key: 'a', name: 'A', order: 1, ownerKind: 'capability', owner: 'code', requires: {} },
        ],
      });
      const card = await board.createCard({ title: 'x', ownerUserId: 'usr_a' });
      if (!card.ok) throw new Error('card');
      await board.moveCard(card.value.id, 'a');
      expect((await board.claim({ agentId: 'agt_c', capabilities: ['code'] })).claimed).toBe(true);
    });
  });
});

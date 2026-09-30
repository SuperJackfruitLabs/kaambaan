import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('BoardDO — planning columns', () => {
  it('a new card reads back with empty labels and no due or archived date', async () => {
    await runInDurableObject(stubFor('pc-defaults'), async (board: BoardDO) => {
      await board.init({ id: 'brd_pc', tenantId: 'tnt_a', name: 'PC', stages: STAGES });
      const created = await board.createCard({ title: 'A card', ownerUserId: 'usr_a' });
      if (!created.ok) throw new Error(created.message);
      expect(created.value.labels).toEqual([]);
      expect(created.value.dueAt).toBeNull();
      expect(created.value.archivedAt).toBeNull();
    });
  });

  it('migrates an existing spec.due onto the column and clears it from the spec', async () => {
    await runInDurableObject(stubFor('pc-backfill'), async (board: BoardDO) => {
      await board.init({ id: 'brd_pc2', tenantId: 'tnt_a', name: 'PC2', stages: STAGES });
      const created = await board.createCard({
        title: 'Legacy card',
        ownerUserId: 'usr_a',
        spec: { due: '2026-10-05', description: 'kept' },
      });
      if (!created.ok) throw new Error(created.message);
      // Simulate the pre-migration world: the column is cleared, the blob keeps the value.
      await board.__testResetDueToSpec(created.value.id);

      await board.backfillDueDates();

      const card = (await board.getState()).cards[0]!;
      expect(card.dueAt).toBe('2026-10-05');
      expect((card.spec as Record<string, unknown>).due).toBeUndefined();
      expect((card.spec as Record<string, unknown>).description).toBe('kept');
    });
  });
});

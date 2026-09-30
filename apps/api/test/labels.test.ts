import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { createLabel, listLabels, deleteLabel, unknownLabelIds } from '../src/db/labels';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_lbl', 'labels', 'Labels')`).run();
});

describe('label catalogue', () => {
  it('refuses a second label with the same name in one tenant', async () => {
    await createLabel(env.DB, 'tnt_lbl', { name: 'urgent', colour: '#f00' });
    await expect(createLabel(env.DB, 'tnt_lbl', { name: 'urgent', colour: '#0f0' })).rejects.toThrow();
  });

  it('is tenant-scoped', async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_other', 'other', 'Other')`).run();
    await createLabel(env.DB, 'tnt_other', { name: 'urgent', colour: '#00f' });
    const mine = await listLabels(env.DB, 'tnt_lbl');
    expect(mine.filter((l) => l.name === 'urgent')).toHaveLength(1);
  });

  it('reports unknown ids, so a card cannot carry a label that does not exist', async () => {
    const live = await createLabel(env.DB, 'tnt_lbl', { name: 'chore', colour: '#888' });
    expect(await unknownLabelIds(env.DB, 'tnt_lbl', [live.id, 'lbl_deadbeefdeadbeef'])).toEqual([
      'lbl_deadbeefdeadbeef',
    ]);
  });
});

describe('applying labels to a card', () => {
  it('stores ids and reads them back', async () => {
    const label = await createLabel(env.DB, 'tnt_lbl', { name: 'blog', colour: '#ff0' });
    await runInDurableObject(stubFor('lbl-apply'), async (board: BoardDO) => {
      await board.init({ id: 'brd_lbl', tenantId: 'tnt_lbl', name: 'L', stages: STAGES });
      const created = await board.createCard({ title: 'Post', ownerUserId: 'usr_a' });
      if (!created.ok) throw new Error(created.message);
      const updated = await board.updateCard(created.value.id, { labels: [label.id] });
      if (!updated.ok) throw new Error(updated.message);
      expect(updated.value.labels).toEqual([label.id]);
    });
  });

  it('ignores an id whose label was deleted, rather than failing to render the card', async () => {
    const doomed = await createLabel(env.DB, 'tnt_lbl', { name: 'temporary', colour: '#ccc' });
    await runInDurableObject(stubFor('lbl-stale'), async (board: BoardDO) => {
      await board.init({ id: 'brd_lbl2', tenantId: 'tnt_lbl', name: 'L2', stages: STAGES });
      const created = await board.createCard({ title: 'Post', ownerUserId: 'usr_a' });
      if (!created.ok) throw new Error(created.message);
      await board.updateCard(created.value.id, { labels: [doomed.id] });
      expect(await deleteLabel(env.DB, 'tnt_lbl', doomed.id)).toBe(true);
      // The card still reads: a stale id is a cosmetic condition, not a broken card.
      const card = (await board.getState()).cards[0]!;
      expect(card.labels).toEqual([doomed.id]);
    });
  });
});

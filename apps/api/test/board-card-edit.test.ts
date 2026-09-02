import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { resolveReferenceInput } from '../src/references/resolve';

const PIPE: BoardInit['stages'] = [{ key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' }];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('BoardDO — updateCard / deleteCard (docs/07)', () => {
  it('updates a card title + priority, and 404s an unknown card', async () => {
    await runInDurableObject(stubFor('edit-1'), async (board: BoardDO) => {
      await board.init({ id: 'brd_e', tenantId: 'tnt_a', name: 'E', stages: PIPE });
      const c = await board.createCard({ title: 'Old', ownerUserId: 'usr_a', priority: 0 });
      if (!c.ok) throw new Error('card');

      const up = await board.updateCard(c.value.id, { title: 'Renamed', priority: 7, spec: { notes: 'hi' } });
      if (!up.ok) throw new Error('update failed');
      expect(up.value.title).toBe('Renamed');
      expect(up.value.priority).toBe(7);

      const snap = await board.getState();
      expect(snap.cards.find((x) => x.id === c.value.id)).toMatchObject({ title: 'Renamed', priority: 7 });

      const bad = await board.updateCard('card_missing', { title: 'x' });
      expect(bad).toMatchObject({ ok: false, code: 'CARD_NOT_FOUND' });
    });
  });

  it('deletes a card and its references/activities', async () => {
    await runInDurableObject(stubFor('edit-2'), async (board: BoardDO) => {
      await board.init({ id: 'brd_d', tenantId: 'tnt_a', name: 'D', stages: PIPE });
      const c = await board.createCard({ title: 'Doomed', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');
      await board.addReference(resolveReferenceInput({ cardId: c.value.id, url: 'https://x.y/1', addedBy: 'user' }));

      const del = await board.deleteCard(c.value.id);
      expect(del.ok).toBe(true);

      const snap = await board.getState();
      expect(snap.cards.find((x) => x.id === c.value.id)).toBeUndefined();
      expect(snap.references.filter((r) => r.cardId === c.value.id)).toEqual([]);

      expect(await board.deleteCard(c.value.id)).toMatchObject({ ok: false, code: 'CARD_NOT_FOUND' });
    });
  });
});

/**
 * A card's owner was fixed to whoever created it: no reassign, no "assign to me", no unassign, on
 * a board whose whole purpose is handing work between people and agents.
 */
describe('BoardDO — a card can be reassigned', () => {
  it('changes the owner without touching the recorded dispatch authority', async () => {
    await runInDurableObject(stubFor('ce-owner'), async (board: BoardDO) => {
      await board.init({ id: 'brd_ce_o', tenantId: 'tnt_a', name: 'CE', stages: PIPE });
      const made = await board.createCard({ title: 'x', ownerUserId: 'usr_a', queuedGrant: ['prn_0123456789abcdef0123'] });
      expect(made.ok).toBe(true);
      if (!made.ok) return;

      const r = await board.updateCard(made.value.id, { ownerUserId: 'usr_b' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.ownerUserId).toBe('usr_b');
      // Who is answerable for a card and who authorised its dispatch are different questions, and
      // only the second is checked at claim time — so reassigning must not rewrite it.
      expect(r.value.queuedGrant).toEqual(['prn_0123456789abcdef0123']);
      expect(r.value.queuedBy).toBe('usr_a');
    });
  });
});

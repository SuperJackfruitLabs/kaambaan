import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit, type CardView } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function make(board: BoardDO, title: string, patch: { priority?: number; dueAt?: string }): Promise<CardView> {
  const r = await board.createCard({ title, ownerUserId: 'usr_a', priority: patch.priority ?? 0 });
  if (!r.ok) throw new Error(r.message);
  if (patch.dueAt) {
    const u = await board.updateCard(r.value.id, { dueAt: patch.dueAt });
    if (!u.ok) throw new Error(u.message);
    return u.value;
  }
  return r.value;
}

describe('due dates in claim order', () => {
  it('prefers the sooner due date at equal priority', async () => {
    await runInDurableObject(stubFor('due-order'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due', tenantId: 'tnt_a', name: 'D', stages: STAGES });
      const later = await make(board, 'Later', { dueAt: '2026-12-01' });
      const sooner = await make(board, 'Sooner', { dueAt: '2026-10-01' });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(sooner.id);
      expect(claim.card.id).not.toBe(later.id);
    });
  });

  it('never lets a due date outrank priority', async () => {
    await runInDurableObject(stubFor('due-vs-pri'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due2', tenantId: 'tnt_a', name: 'D2', stages: STAGES });
      await make(board, 'Due tomorrow, low priority', { priority: 0, dueAt: '2026-10-01' });
      const urgent = await make(board, 'No due date, high priority', { priority: 5 });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(urgent.id);
    });
  });

  it('puts undated cards last, not first', async () => {
    await runInDurableObject(stubFor('due-nulls'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due3', tenantId: 'tnt_a', name: 'D3', stages: STAGES });
      await make(board, 'Undated', {});
      const dated = await make(board, 'Dated', { dueAt: '2027-01-01' });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(dated.id);
    });
  });

  it('does not hand out an archived card', async () => {
    await runInDurableObject(stubFor('due-archived'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due4', tenantId: 'tnt_a', name: 'D4', stages: STAGES });
      const card = await make(board, 'Archived', {});
      await board.updateCard(card.id, { archivedAt: '2026-09-30T00:00:00.000Z' });
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(false);
    });
  });

  it('does not ADVERTISE an archived card either — discovery and claim must agree', async () => {
    await runInDurableObject(stubFor('due-archived-count'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due4b', tenantId: 'tnt_a', name: 'D4b', stages: STAGES });
      const card = await make(board, 'Archived', {});
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(1);

      await board.updateCard(card.id, { archivedAt: '2026-09-30T00:00:00.000Z' });

      // `countReadyForCapabilities` is what `superpipeline_list_work` reports as `readyForYou`.
      // If it still says 1 while claim says nothing is claimable, an agent polls, sees work, claims
      // nothing, and polls again — forever.
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(0);
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(false);
    });
  });
});

describe('overdue notification', () => {
  it('notifies the owner once, not once per tick', async () => {
    await runInDurableObject(stubFor('due-notify'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due5', tenantId: 'tnt_a', name: 'D5', stages: STAGES });
      await make(board, 'Overdue', { dueAt: '2026-09-01' });

      const first = await board.sweepBoard('2026-09-30T10:00:00.000Z');
      expect(first.overdueNotified).toBe(1);

      const second = await board.sweepBoard('2026-09-30T10:05:00.000Z');
      expect(second.overdueNotified).toBe(0);

      const notes = (await board.getNotifications()).filter((n) => n.kind === 'overdue');
      expect(notes).toHaveLength(1);
    });
  });

  it('resets the notified flag when the due date actually changes, allowing a second notification', async () => {
    // Unlike the case above, `updateCard` here moves an ALREADY-notified card to a new (still
    // past) due date, so `overdue_notified_at` starts non-NULL and this exercises the reset as a
    // reset, not as a no-op on a column that was already NULL.
    await runInDurableObject(stubFor('due-reset'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due8', tenantId: 'tnt_a', name: 'D8', stages: STAGES });
      const card = await make(board, 'Overdue twice', { dueAt: '2026-09-01' });

      expect((await board.sweepBoard('2026-09-30T10:00:00.000Z')).overdueNotified).toBe(1);

      const u = await board.updateCard(card.id, { dueAt: '2026-09-15' });
      if (!u.ok) throw new Error(u.message);

      expect((await board.sweepBoard('2026-09-30T10:05:00.000Z')).overdueNotified).toBe(1);

      const notes = (await board.getNotifications()).filter((n) => n.kind === 'overdue');
      expect(notes).toHaveLength(2);
    });
  });

  it('says nothing about a card that is not yet due', async () => {
    await runInDurableObject(stubFor('due-future'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due6', tenantId: 'tnt_a', name: 'D6', stages: STAGES });
      await make(board, 'Future', { dueAt: '2027-01-01' });
      expect((await board.sweepBoard('2026-09-30T10:00:00.000Z')).overdueNotified).toBe(0);
    });
  });

  it('says nothing about an overdue card that is already finished', async () => {
    await runInDurableObject(stubFor('due-done'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due7', tenantId: 'tnt_a', name: 'D7', stages: STAGES });
      const card = await make(board, 'Done but late', { dueAt: '2026-09-01' });
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'late but done' } });
      expect(card.id).toBeDefined();
      expect((await board.sweepBoard('2026-09-30T10:00:00.000Z')).overdueNotified).toBe(0);
    });
  });
});

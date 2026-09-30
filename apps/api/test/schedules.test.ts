import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function boardWithSchedule(board: BoardDO, name: string, patch: Record<string, unknown> = {}) {
  await board.init({ id: `brd_${name}`, tenantId: 'tnt_a', name, stages: STAGES });
  const r = await board.createSchedule({
    title: 'Sweep the logs',
    rule: 'daily at 09:00',
    timezone: 'UTC',
    overlap: 'skip',
    createdBy: 'usr_a',
    ...patch,
  });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe('schedules', () => {
  it('refuses an unreadable rule at creation, with the parser’s own message', async () => {
    await runInDurableObject(stubFor('sch-bad'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sb', tenantId: 'tnt_a', name: 'SB', stages: STAGES });
      const r = await board.createSchedule({
        title: 'x', rule: 'every 2 minutes', timezone: 'UTC', overlap: 'skip', createdBy: 'usr_a',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain('5');
    });
  });

  it('computes the first fire time at creation', async () => {
    await runInDurableObject(stubFor('sch-first'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schfirst');
      expect(s.nextFireAt).toMatch(/T09:00:00\.000Z$/);
    });
  });

  it('creates a card when due, and advances next_fire_at past it', async () => {
    await runInDurableObject(stubFor('sch-fire'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schfire');
      const result = await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      expect(result.fired).toEqual([s.id]);

      const cards = (await board.getState()).cards;
      expect(cards).toHaveLength(1);
      expect(cards[0]!.title).toBe('Sweep the logs');

      const after = (await board.listSchedules())[0]!;
      expect(new Date(after.nextFireAt).getTime()).toBeGreaterThan(new Date('2099-01-01T10:00:00.000Z').getTime());
      expect(after.lastCardId).toBe(cards[0]!.id);
    });
  });

  it('does not fire twice for one due time', async () => {
    await runInDurableObject(stubFor('sch-once'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schonce');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      const second = await board.fireDueSchedules('2099-01-01T10:01:00.000Z');
      expect(second.fired).toEqual([]);
      expect((await board.getState()).cards).toHaveLength(1);
    });
  });

  it('skips while the previous card is still open, and records the skip visibly', async () => {
    await runInDurableObject(stubFor('sch-skip'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schskip');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      const skipped = await board.fireDueSchedules('2099-01-03T10:00:00.000Z');

      expect(skipped.skipped).toEqual([s.id]);
      expect((await board.getState()).cards).toHaveLength(1);
      expect((await board.listSchedules())[0]!.skipCount).toBe(1);

      // A silent skip is the failure mode this guards against: it must be on the audit log.
      const events = await board.getEvents(50);
      expect(events.some((e) => e.type === 'schedule.skipped')).toBe(true);
    });
  });

  it('fires again once the previous card is finished', async () => {
    await runInDurableObject(stubFor('sch-resume'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schresume');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'swept' } });

      const again = await board.fireDueSchedules('2099-01-03T10:00:00.000Z');
      expect(again.fired).toHaveLength(1);
      expect((await board.getState()).cards).toHaveLength(2);
    });
  });

  it('fires regardless of an open card when overlap is allow', async () => {
    await runInDurableObject(stubFor('sch-allow'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schallow', { overlap: 'allow' });
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      await board.fireDueSchedules('2099-01-03T10:00:00.000Z');
      expect((await board.getState()).cards).toHaveLength(2);
    });
  });

  it('a disabled schedule never fires', async () => {
    await runInDurableObject(stubFor('sch-off'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schoff');
      await board.updateSchedule(s.id, { enabled: false });
      expect((await board.fireDueSchedules('2099-01-01T10:00:00.000Z')).fired).toEqual([]);
      expect((await board.getState()).cards).toHaveLength(0);
    });
  });

  it('a scheduled card is claimable — the grant fallback is not optional', async () => {
    await runInDurableObject(stubFor('sch-claimable'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schclaim');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      // Without createCardFromTrigger's queuedGrant fallback this is false under enforcement, and
      // every scheduled card would sit on the board forever. That is the whole reason this path
      // goes through the trigger helper rather than createCard.
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(true);
    });
  });
});

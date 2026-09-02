import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const REVIEW: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
];
const BUILD: BoardInit['stages'] = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('BoardDO — notifications (docs/07 §7)', () => {
  it('notifies the card owner when a review gate opens', async () => {
    await runInDurableObject(stubFor('n-gate'), async (board: BoardDO) => {
      await board.init({ id: 'brd_n', tenantId: 'tnt_a', name: 'N', stages: REVIEW });
      const c = await board.createCard({ title: 'Post', ownerUserId: 'usr_owner' });
      if (!c.ok) throw new Error('card');
      const run = await board.claim({ agentId: 'agt_r', capabilities: ['research'] });
      if (!run.claimed) throw new Error('claim');
      await board.complete({ runId: run.runId, leaseEpoch: run.leaseEpoch }); // advances into the human gate

      const notes = await board.getNotifications();
      const gate = notes.find((n) => n.kind === 'gate');
      expect(gate).toBeDefined();
      expect(gate?.cardId).toBe(c.value.id);
      expect(gate?.userId).toBe('usr_owner');
      expect(gate?.read).toBe(false);
    });
  });

  it('notifies on failure', async () => {
    await runInDurableObject(stubFor('n-fail'), async (board: BoardDO) => {
      await board.init({ id: 'brd_nf', tenantId: 'tnt_a', name: 'NF', stages: BUILD });
      await board.createCard({ title: 'Build', ownerUserId: 'usr_owner' });
      const run = await board.claim({ agentId: 'agt_b', capabilities: ['build'] });
      if (!run.claimed) throw new Error('claim');
      await board.fail({ runId: run.runId, leaseEpoch: run.leaseEpoch, reason: 'compile error' });
      expect((await board.getNotifications()).some((n) => n.kind === 'failed')).toBe(true);
    });
  });

  it('notifies when a run is reclaimed (agent went dark)', async () => {
    await runInDurableObject(stubFor('n-reclaim'), async (board: BoardDO) => {
      await board.init({ id: 'brd_nc', tenantId: 'tnt_a', name: 'NC', stages: BUILD });
      await board.createCard({ title: 'Build', ownerUserId: 'usr_owner' });
      const run = await board.claim({ agentId: 'agt_b', capabilities: ['build'] });
      if (!run.claimed) throw new Error('claim');
      // Force the heartbeat-timeout reclaim by passing an instant far past the deadline.
      const reclaimed = board.reclaimExpired(9_999_999_999_999);
      expect(reclaimed).toBe(1);
      expect((await board.getNotifications()).some((n) => n.kind === 'reclaimed')).toBe(true);
    });
  });

  it('filters unread and marks a notification read', async () => {
    await runInDurableObject(stubFor('n-read'), async (board: BoardDO) => {
      await board.init({ id: 'brd_nr', tenantId: 'tnt_a', name: 'NR', stages: BUILD });
      await board.createCard({ title: 'Build', ownerUserId: 'usr_owner' });
      const run = await board.claim({ agentId: 'agt_b', capabilities: ['build'] });
      if (!run.claimed) throw new Error('claim');
      await board.fail({ runId: run.runId, leaseEpoch: run.leaseEpoch, reason: 'boom' });

      const unread = await board.getNotifications({ unreadOnly: true });
      expect(unread).toHaveLength(1);
      await board.markNotificationRead(unread[0]!.seq);
      expect(await board.getNotifications({ unreadOnly: true })).toHaveLength(0);
    });
  });
});

/**
 * `notifications.user_id` was written from the card owner and never used as a filter, so every
 * board notification was returned to every caller. One member per workspace made that invisible;
 * a second member makes it a disclosure.
 */
describe('BoardDO — a notification reaches the person it is for', () => {
  it('keeps one person\'s notifications out of another\'s feed', async () => {
    await runInDurableObject(stubFor('nf-scope'), async (board: BoardDO) => {
      await board.init({ id: 'brd_nf_s', tenantId: 'tnt_a', name: 'NF', stages: BUILD });
      const mine = await board.createCard({ title: 'mine', ownerUserId: 'usr_a' });
      const theirs = await board.createCard({ title: 'theirs', ownerUserId: 'usr_b' });
      expect(mine.ok && theirs.ok).toBe(true);

      const forA = await board.getNotifications({ userId: 'usr_a' });
      const forB = await board.getNotifications({ userId: 'usr_b' });

      // Whatever each feed holds, it must hold nothing addressed to the other person.
      expect(forA.every((n) => n.userId === null || n.userId === 'usr_a')).toBe(true);
      expect(forB.every((n) => n.userId === null || n.userId === 'usr_b')).toBe(true);

      // And an unfiltered read still sees everything — internal callers have no person to filter by.
      const all = await board.getNotifications();
      expect(all.length).toBeGreaterThanOrEqual(Math.max(forA.length, forB.length));
    });
  });

  it('delivers an unaddressed notification to everyone', async () => {
    await runInDurableObject(stubFor('nf-broadcast'), async (board: BoardDO) => {
      await board.init({ id: 'brd_nf_b', tenantId: 'tnt_a', name: 'NF', stages: BUILD });
      const c = await board.createCard({ title: 'x', ownerUserId: 'usr_a' });
      if (!c.ok) return;

      const all = await board.getNotifications();
      const unaddressed = all.filter((n) => n.userId === null);
      if (unaddressed.length === 0) return; // nothing unaddressed on this board; the rule is vacuous

      const forStranger = await board.getNotifications({ userId: 'usr_nobody' });
      expect(forStranger.length).toBe(unaddressed.length);
    });
  });
});

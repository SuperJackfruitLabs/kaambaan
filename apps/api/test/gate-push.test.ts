/**
 * `gate.pending` — the push event that carries an approval to a human.
 *
 * Two things here are not obvious and are the point of the file:
 *
 * 1. **Fan-out is by subscription, not by capability.** `work.available` asks
 *    "who could claim this stage"; a gate asks "who owns this card". A review
 *    stage is human-owned, so a capability match would deliver a gate to
 *    nobody at all.
 * 2. **The alarm is the only unattended drain.** `dispatchPushDeliveries` was
 *    reachable only from `POST …/push/dispatch` — so before this, a queued
 *    gate sat pending until something outside the board poked it.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const REVIEW_PIPELINE: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
];

const HOOK = 'https://hub.example/api/bridge/kaambaan/push';

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

/** Drive research→complete so the card lands on the review gate. */
async function openGate(board: BoardDO, boardId: string): Promise<string> {
  await board.init({ id: boardId, tenantId: 'tnt_a', name: 'Gated', stages: REVIEW_PIPELINE });
  const card = await board.createCard({ title: 'Add OAuth login', ownerUserId: 'usr_a' });
  if (!card.ok) throw new Error(card.message);
  const c = await board.claim({ agentId: 'agt_r', capabilities: ['research'] });
  if (!c.claimed) throw new Error('expected a research claim');
  await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'drafted' } });
  return card.value.id;
}

describe('BoardDO — gate.pending (charter 2026-08-30)', () => {
  it('queues a delivery carrying everything a projection needs', async () => {
    await runInDurableObject(stubFor('gp-queue'), async (board: BoardDO) => {
      await board.init({ id: 'brd_gp', tenantId: 'tnt_a', name: 'G', stages: REVIEW_PIPELINE });
      await board.registerPushConfig({
        agentId: 'agt_bridge', url: HOOK, token: 's3cret', capabilities: [], events: ['gate.pending'],
      });
      const cardId = await openGate(board, 'brd_gp');

      const deliveries = await board.getPushDeliveries();
      expect(deliveries).toHaveLength(1);
      const body = JSON.parse(deliveries[0]!.body);
      expect(body).toMatchObject({
        event: 'gate.pending',
        cardId,
        stageKey: 'review',
        returnStageKey: 'research',
        cardTitle: 'Add OAuth login',
        producedBy: 'agt_r',
      });
      expect(body.gateId).toMatch(/^gate_/);
    });
  });

  it('sends the option ids kaambaan resolves against, not its own vocabulary', async () => {
    await runInDurableObject(stubFor('gp-options'), async (board: BoardDO) => {
      await board.init({ id: 'brd_go', tenantId: 'tnt_a', name: 'G', stages: REVIEW_PIPELINE });
      await board.registerPushConfig({ agentId: 'a', url: HOOK, token: 's', events: ['gate.pending'] });
      await openGate(board, 'brd_go');

      const body = JSON.parse((await board.getPushDeliveries())[0]!.body);
      // `id`/`label` on the wire; `name`/`title` is the board's own shape and
      // stops here. Pinned by agentpod fixtures/…/matrix_gate_events.json.
      expect(body.options).toEqual([
        { id: 'approve', label: 'Approve' },
        { id: 'request_changes', label: 'Request changes' },
        { id: 'reject', label: 'Reject' },
      ]);
    });
  });

  it('does not send a gate to a config that only asked for work.available', async () => {
    await runInDurableObject(stubFor('gp-unsub'), async (board: BoardDO) => {
      await board.init({ id: 'brd_gu', tenantId: 'tnt_a', name: 'G', stages: REVIEW_PIPELINE });
      await board.registerPushConfig({
        agentId: 'agt_worker', url: HOOK, token: 's', capabilities: ['research'], events: ['work.available'],
      });
      await openGate(board, 'brd_gu');

      const gates = (await board.getPushDeliveries()).filter(
        (d) => JSON.parse(d.body).event === 'gate.pending',
      );
      expect(gates).toHaveLength(0);
    });
  });

  it('sends a gate to a subscriber holding no capabilities at all', async () => {
    // The regression this guards: copying work.available's capability match
    // would deliver a gate to nobody, because a review stage is human-owned
    // and no config advertises a capability for it.
    await runInDurableObject(stubFor('gp-nocaps'), async (board: BoardDO) => {
      await board.init({ id: 'brd_gn', tenantId: 'tnt_a', name: 'G', stages: REVIEW_PIPELINE });
      await board.registerPushConfig({ agentId: 'agt_bridge', url: HOOK, token: 's', capabilities: [], events: ['gate.pending'] });
      await openGate(board, 'brd_gn');

      expect(await board.getPushDeliveries()).toHaveLength(1);
    });
  });

  it('leaves an alarm set so the queue drains without an external poke', async () => {
    await runInDurableObject(stubFor('gp-alarm'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_ga', tenantId: 'tnt_a', name: 'G', stages: REVIEW_PIPELINE });
      await board.registerPushConfig({ agentId: 'a', url: HOOK, token: 's', events: ['gate.pending'] });
      await openGate(board, 'brd_ga');

      expect(await board.getPushDeliveries()).toHaveLength(1);
      const alarm = await state.storage.getAlarm();
      expect(alarm, 'a queued gate with no alarm never leaves the board').not.toBeNull();
    });
  });

  it('keeps the alarm while a delivery is still retryable', async () => {
    await runInDurableObject(stubFor('gp-retry'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_gr', tenantId: 'tnt_a', name: 'G', stages: REVIEW_PIPELINE });
      await board.registerPushConfig({ agentId: 'a', url: HOOK, token: 's', events: ['gate.pending'] });
      await openGate(board, 'brd_gr');

      // Every attempt fails. The row must stay retryable, and the alarm must
      // come back — a terminal first failure is what made this at-most-once.
      await board.dispatchPushDeliveries(async () => ({ status: 500 }));
      const after = await board.getPushDeliveries();
      expect(after[0]!.status).toBe('failed');
      expect(after[0]!.attempts).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it('dead-letters a delivery rather than retrying it forever', async () => {
    await runInDurableObject(stubFor('gp-dead'), async (board: BoardDO) => {
      await board.init({ id: 'brd_gd', tenantId: 'tnt_a', name: 'G', stages: REVIEW_PIPELINE });
      await board.registerPushConfig({ agentId: 'a', url: HOOK, token: 's', events: ['gate.pending'] });
      await openGate(board, 'brd_gd');

      for (let i = 0; i < 6; i++) await board.dispatchPushDeliveries(async () => ({ status: 500 }));
      const dead = (await board.getPushDeliveries()).find((d) => d.status === 'dead');
      expect(dead, 'a gate nobody can be told about must stop trying and stay visible').toBeDefined();
      expect(dead!.attempts).toBe(5);
    });
  });
});

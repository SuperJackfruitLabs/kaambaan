import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { runRow, withReporting, trackBoard, quietBoards } from './helpers/superwitness';

const BUILD: BoardInit['stages'] = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];
const SUBMIT: BoardInit['stages'] = [
  { key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build', gate: 'approval' },
  { key: 'ship', name: 'Ship', order: 1, ownerKind: 'capability', owner: 'ship' },
];
const DOUBLE_REVIEW: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'signoff', name: 'Sign-off', order: 2, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 3, ownerKind: 'capability', owner: 'publish' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return trackBoard(env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>);
}

afterEach(quietBoards);

async function start(board: BoardDO, id: string, stages: BoardInit['stages'], cap: string) {
  await board.init({ id, tenantId: 'tnt_sw', name: 'B', stages });
  const card = await board.createCard({ title: 'Work', ownerUserId: 'usr_a' });
  if (!card.ok) throw new Error(card.message);
  const c = await board.claim({ agentId: 'agt_w', capabilities: [cap] });
  if (!c.claimed) throw new Error('expected a claim');
  return { cardId: card.value.id, runId: c.runId, leaseEpoch: c.leaseEpoch };
}

async function reported(board: BoardDO, state: DurableObjectState, runId: string) {
  const row = (await board.getRunReportOutbox()).find((r) => r.runId === runId)!;
  expect(row.reportedAt).toBe(runRow(state, runId).updated_at);
  return { status: row.draft.status, gen: row.gen };
}

function pendingGateId(state: DurableObjectState): string {
  return state.storage.sql.exec(`SELECT id FROM gates WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`).one().id as string;
}

describe('superwitness reports — waits', () => {
  it('an elicitation makes the run waiting; the answer makes it running again', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sww-elicit'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sww_e', BUILD, 'build');
        await board.postActivity({ runId, leaseEpoch, type: 'elicitation', body: 'Which region?' });
        expect(await reported(board, state, runId)).toEqual({ status: 'waiting', gen: 2 });
        const elicitationId = state.storage.sql.exec(`SELECT id FROM elicitations WHERE run_id = ?`, runId).one().id as string;
        const answered = await board.answerElicitation({ elicitationId, answeredBy: 'usr_h', text: 'eu' });
        expect(answered.ok).toBe(true);
        expect(await reported(board, state, runId)).toEqual({ status: 'running', gen: 3 });
      }),
    ));

  it.each([
    ['approve', 'succeeded'],
    ['reject', 'failed'],
    ['request_changes', 'failed'],
  ] as const)('a gate decision %s → %s for the run it judges', (decision, status) =>
    withReporting(() =>
      runInDurableObject(stubFor(`sww-gate-${decision}`), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, `brd_sww_g_${decision}`, SUBMIT, 'build');
        await board.submitForReview({ runId, leaseEpoch });
        const r = await board.resolveGate({ gateId: pendingGateId(state), decision, decidedBy: 'usr_h' });
        expect(r.ok).toBe(true);
        expect((await reported(board, state, runId)).status).toBe(status);
      }),
    ));

  it('an approval into another human gate keeps the run waiting (chained gate)', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sww-chain'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sww_chain', DOUBLE_REVIEW, 'research');
        await board.complete({ runId, leaseEpoch, handoff: { summary: 'drafted' } });
        expect((await reported(board, state, runId)).status).toBe('waiting');
        await board.resolveGate({ gateId: pendingGateId(state), decision: 'approve', decidedBy: 'usr_h' });
        const after = await reported(board, state, runId);
        expect(after.status).toBe('waiting');
        expect(after.gen).toBe(3); // the decision was still reported — it bumped updated_at
        await board.resolveGate({ gateId: pendingGateId(state), decision: 'approve', decidedBy: 'usr_i' });
        expect((await reported(board, state, runId)).status).toBe('succeeded');
      }),
    ));

  it('a legacy gate (no run_id) still reports the run it was opened for', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sww-legacy'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sww_legacy', SUBMIT, 'build');
        await board.submitForReview({ runId, leaseEpoch });
        state.storage.sql.exec(`UPDATE gates SET run_id = NULL`); // as gates opened before 2026-09-29 read
        const r = await board.resolveGate({ gateId: pendingGateId(state), decision: 'approve', decidedBy: 'usr_h' });
        expect(r.ok).toBe(true);
        expect((await reported(board, state, runId)).status).toBe('succeeded');
      }),
    ));

  it('a manual move off a pending gate → the judged run is cancelled', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sww-move-gate'), async (board: BoardDO, state) => {
        const { cardId, runId, leaseEpoch } = await start(board, 'brd_sww_mg', SUBMIT, 'build');
        await board.submitForReview({ runId, leaseEpoch });
        const moved = await board.moveCard(cardId, 'ship', 'usr_x');
        expect(moved.ok).toBe(true);
        expect((await reported(board, state, runId)).status).toBe('cancelled');
      }),
    ));

  it('a manual move cancels a pending question → the asking run is running again', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sww-move-elicit'), async (board: BoardDO, state) => {
        await board.init({ id: 'brd_sww_me', tenantId: 'tnt_sw', name: 'B', stages: SUBMIT });
        const card = await board.createCard({ title: 'Work', ownerUserId: 'usr_a' });
        if (!card.ok) throw new Error(card.message);
        const c = await board.claim({ agentId: 'agt_w', capabilities: ['build'] });
        if (!c.claimed) throw new Error('expected a claim');
        await board.postActivity({ runId: c.runId, leaseEpoch: c.leaseEpoch, type: 'elicitation', body: 'Which?' });
        expect((await reported(board, state, c.runId)).status).toBe('waiting');
        await board.moveCard(card.value.id, 'ship', 'usr_x');
        expect((await reported(board, state, c.runId)).status).toBe('running');
      }),
    ));
});

// A parent whose run completes with an open child defers its advance, so the run is reported
// `succeeded`. When the child stops being open, the replay opens a human gate judging that run, and
// the run must be reported `waiting` again — by whichever of the three ways the child goes.
const DEFER: BoardInit['stages'] = [
  { key: 'work', name: 'Work', order: 0, ownerKind: 'capability', owner: 'work' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
];

describe('superwitness reports — deferred parent advance', () => {
  it.each(['resolve', 'delete', 'unlink'] as const)('the replayed advance into a human gate reports the parent run waiting (%s the child)', (how) =>
    withReporting(() =>
      runInDurableObject(stubFor(`sww-defer-${how}`), async (board: BoardDO, state) => {
        await board.init({ id: `brd_sww_defer_${how}`, tenantId: 'tnt_sw', name: 'B', stages: DEFER });
        const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
        if (!p.ok) throw new Error(p.message);
        const cp = await board.claim({ agentId: 'agt_p', capabilities: ['work'] });
        if (!cp.claimed) throw new Error('expected the parent claim');
        const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
        if (!child.ok) throw new Error(child.message);
        await board.complete({ runId: cp.runId, leaseEpoch: cp.leaseEpoch, handoff: { summary: 'split' } });
        const deferred = await reported(board, state, cp.runId);
        expect(deferred.status).toBe('succeeded');
        const before = runRow(state, cp.runId).updated_at as string;

        if (how === 'resolve') {
          const cc = await board.claim({ agentId: 'agt_c', capabilities: ['work'] });
          if (!cc.claimed || cc.card.id !== child.value.id) throw new Error('expected the child claim');
          await board.complete({ runId: cc.runId, leaseEpoch: cc.leaseEpoch, handoff: { summary: 'c' } });
          const childGate = (await board.getState()).gates.find((g) => g.cardId === child.value.id)!;
          expect((await board.resolveGate({ gateId: childGate.id, decision: 'approve', decidedBy: 'usr_h' })).ok).toBe(true);
        } else {
          await state.storage.deleteAlarm(); // the resuming verb must arm the drain itself
          const r = how === 'delete' ? await board.deleteCard(child.value.id) : await board.removeLink(p.value.id, child.value.id, 'parent');
          expect(r.ok).toBe(true);
          expect(await state.storage.getAlarm()).not.toBeNull();
          expect((await state.storage.getAlarm())!).toBeLessThanOrEqual(Date.now() + 1000);
        }

        const after = await reported(board, state, cp.runId);
        expect(after.status).toBe('waiting');
        expect(after.gen).toBeGreaterThan(deferred.gen);
        expect(Date.parse(runRow(state, cp.runId).updated_at as string)).toBeGreaterThan(Date.parse(before));
      }),
    ));
});

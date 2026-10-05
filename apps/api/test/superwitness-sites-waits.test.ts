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

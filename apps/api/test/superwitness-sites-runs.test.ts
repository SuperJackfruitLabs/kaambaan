import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { runRow, withReporting } from './helpers/superwitness';

const BUILD: BoardInit['stages'] = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];
const CHECKED: BoardInit['stages'] = [
  { key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build', completion: { handoff: ['summary'] } },
];
const REVIEW: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
];
const SUBMIT: BoardInit['stages'] = [
  { key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build', gate: 'approval' },
  { key: 'ship', name: 'Ship', order: 1, ownerKind: 'capability', owner: 'ship' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function start(board: BoardDO, id: string, stages: BoardInit['stages'], cap: string) {
  await board.init({ id, tenantId: 'tnt_sw', name: 'B', stages });
  await board.createCard({ title: 'Work', ownerUserId: 'usr_a' });
  const c = await board.claim({ agentId: 'agt_w', capabilities: [cap] });
  if (!c.claimed) throw new Error('expected a claim');
  return { runId: c.runId, leaseEpoch: c.leaseEpoch };
}

/** The run's outbox row must say `status`/`sourceStatus`, at the run's own updated_at, newer than the claim's. */
async function expectReported(board: BoardDO, state: DurableObjectState, runId: string, status: string, sourceStatus: string, claimGen = 1) {
  const row = (await board.getRunReportOutbox()).find((r) => r.runId === runId);
  expect(row, 'outbox row').toBeDefined();
  expect(row!.draft.status).toBe(status);
  expect(row!.draft.sourceStatus).toBe(sourceStatus);
  expect(row!.gen).toBeGreaterThan(claimGen);
  expect(row!.reportedAt).toBe(runRow(state, runId).updated_at);
}

describe('superwitness reports — run-ending verbs', () => {
  it('complete with no gate → succeeded', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sws-complete'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sws_c', BUILD, 'build');
        await board.complete({ runId, leaseEpoch, handoff: { summary: 'done' } });
        await expectReported(board, state, runId, 'succeeded', 'completed');
        expect(runRow(state, runId).ended_at).not.toBeNull();
      }),
    ));

  it('complete into a human review stage → waiting on the gate', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sws-complete-gate'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sws_cg', REVIEW, 'research');
        await board.complete({ runId, leaseEpoch, handoff: { summary: 'drafted' } });
        await expectReported(board, state, runId, 'waiting', 'completed');
      }),
    ));

  it('complete with an unmet completion requirement → failed (blocked)', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sws-complete-unmet'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sws_cu', CHECKED, 'build');
        await board.complete({ runId, leaseEpoch, handoff: {} });
        await expectReported(board, state, runId, 'failed', 'blocked');
      }),
    ));

  it('submitForReview → waiting (submitted)', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sws-submit'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sws_s', SUBMIT, 'build');
        await board.submitForReview({ runId, leaseEpoch });
        await expectReported(board, state, runId, 'waiting', 'submitted');
      }),
    ));

  it('block → failed (blocked)', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sws-block'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sws_b', BUILD, 'build');
        await board.block({ runId, leaseEpoch, reason: 'need a key' });
        await expectReported(board, state, runId, 'failed', 'blocked');
      }),
    ));

  it('fail → failed (crashed)', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sws-fail'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sws_f', BUILD, 'build');
        await board.fail({ runId, leaseEpoch, reason: 'tool error' });
        await expectReported(board, state, runId, 'failed', 'crashed');
      }),
    ));

  it('release → cancelled (released)', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sws-release'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sws_r', BUILD, 'build');
        await board.release({ runId, leaseEpoch });
        await expectReported(board, state, runId, 'cancelled', 'released');
      }),
    ));

  it('reclaim of a lapsed lease → failed (reclaimed)', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sws-reclaim'), async (board: BoardDO, state) => {
        const { runId } = await start(board, 'brd_sws_rc', BUILD, 'build');
        expect(board.reclaimExpired(Date.now() + 16 * 60 * 1000)).toBe(1);
        await expectReported(board, state, runId, 'failed', 'reclaimed');
      }),
    ));

  it('a heartbeat is not a status change', () =>
    withReporting(() =>
      runInDurableObject(stubFor('sws-heartbeat'), async (board: BoardDO, state) => {
        const { runId, leaseEpoch } = await start(board, 'brd_sws_h', BUILD, 'build');
        const before = runRow(state, runId).updated_at;
        await board.heartbeat({ runId, leaseEpoch });
        expect(runRow(state, runId).updated_at).toBe(before);
        expect((await board.getRunReportOutbox())[0]!.gen).toBe(1);
      }),
    ));
});

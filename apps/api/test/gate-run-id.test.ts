/**
 * A gate names the run whose work it judges (charter decisions/2026-09-29-evidence-joins-on-the-
 * work-run.md, decision 4). Nullable: gates opened before this have none, and a gate a human
 * opens by moving a card has no run to name.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const REVIEW: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'signoff', name: 'Sign-off', order: 2, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 3, ownerKind: 'capability', owner: 'publish' },
];
const SUBMIT: BoardInit['stages'] = [
  { key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build', gate: 'approval' },
  { key: 'ship', name: 'Ship', order: 1, ownerKind: 'capability', owner: 'ship' },
];

const stubFor = (name: string) => env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
// rowid, not id: the DO clock does not advance without I/O so created_at ties, and ids are random.
const gateRuns = (state: DurableObjectState) =>
  state.storage.sql
    .exec(`SELECT stage_key, run_id, status FROM gates ORDER BY created_at ASC, rowid ASC`)
    .toArray() as Array<{ stage_key: string; run_id: string | null; status: string }>;

describe('gates.run_id', () => {
  it('a gate opened by a completed run names that run', async () => {
    await runInDurableObject(stubFor('grid-complete'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_grid1', tenantId: 'tnt_a', name: 'g', stages: REVIEW });
      await board.createCard({ title: 'post', ownerUserId: 'usr_a' });
      const c = await board.claim({ agentId: 'agt_r', capabilities: ['research'] });
      if (!c.claimed) throw new Error('expected a claim');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'x' } });
      expect(gateRuns(state)).toEqual([{ stage_key: 'review', run_id: c.runId, status: 'pending' }]);
    });
  });

  it('a gate opened by submit-for-review names the submitting run', async () => {
    await runInDurableObject(stubFor('grid-submit'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_grid2', tenantId: 'tnt_a', name: 'g', stages: SUBMIT });
      await board.createCard({ title: 'feature', ownerUserId: 'usr_a' });
      const c = await board.claim({ agentId: 'agt_b', capabilities: ['build'] });
      if (!c.claimed) throw new Error('expected a claim');
      await board.submitForReview({ runId: c.runId, leaseEpoch: c.leaseEpoch });
      expect(gateRuns(state)[0]).toMatchObject({ stage_key: 'build', run_id: c.runId });
    });
  });

  it('an approved gate hands its run to the gate it chains to', async () => {
    await runInDurableObject(stubFor('grid-chain'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_grid3', tenantId: 'tnt_a', name: 'g', stages: REVIEW });
      await board.createCard({ title: 'post', ownerUserId: 'usr_a' });
      const c = await board.claim({ agentId: 'agt_r', capabilities: ['research'] });
      if (!c.claimed) throw new Error('expected a claim');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'x' } });
      const first = (await board.getState()).gates[0]!;
      const r = await board.resolveGate({ gateId: first.id, decision: 'approve', decidedBy: 'usr_reviewer' });
      expect(r.ok).toBe(true);
      expect(gateRuns(state)).toEqual([
        { stage_key: 'review', run_id: c.runId, status: 'resolved' },
        { stage_key: 'signoff', run_id: c.runId, status: 'pending' },
      ]);
    });
  });

  it('the column is added to a board created before it existed', async () => {
    await runInDurableObject(stubFor('grid-legacy'), async (_board: BoardDO, state) => {
      const sql = state.storage.sql;
      // Reproduce the pre-migration schema: a gates table with no run_id, holding a row.
      sql.exec(`DROP TABLE gates`);
      sql.exec(
        `CREATE TABLE gates (
          id TEXT PRIMARY KEY, card_id TEXT NOT NULL, stage_key TEXT NOT NULL, return_stage_key TEXT NOT NULL,
          status TEXT NOT NULL, decision TEXT, comment TEXT, produced_by TEXT NOT NULL DEFAULT '',
          decided_by TEXT, options_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
        )`,
      );
      sql.exec(
        `INSERT INTO gates (id, card_id, stage_key, return_stage_key, status, options_json, created_at)
         VALUES ('gate_old', 'crd_old', 'review', 'research', 'pending', '[]', '2026-01-01T00:00:00.000Z')`,
      );
      expect(sql.exec(`PRAGMA table_info(gates)`).toArray().map((r) => r.name)).not.toContain('run_id');

      // A board waking up runs the schema path in its constructor.
      new BoardDO(state, env as never);

      expect(sql.exec(`PRAGMA table_info(gates)`).toArray().map((r) => r.name)).toContain('run_id');
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name = 'idx_gates_run'`).toArray()).toHaveLength(1);
      expect(sql.exec(`SELECT id, run_id FROM gates`).toArray()).toEqual([{ id: 'gate_old', run_id: null }]);
    });
  });

  // A parent with an open child defers its advance; the replay opens the gate later, so the run
  // must survive in `pending_advance_json`. Child: work then a gate on the last stage, so approving
  // it resolves the child.
  const DEFER: BoardInit['stages'] = [
    { key: 'work', name: 'Work', order: 0, ownerKind: 'capability', owner: 'work' },
    { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  ];
  const deferParentThenResolveChild = async (
    board: BoardDO,
    state: DurableObjectState,
    mutatePending?: (json: string) => string,
  ) => {
    const p = await board.createCard({ title: 'parent', ownerUserId: 'usr_a' });
    if (!p.ok) throw new Error(p.message);
    const cp = await board.claim({ agentId: 'agt_p', capabilities: ['work'] });
    if (!cp.claimed) throw new Error('expected the parent claim');
    const child = await board.createChildCard(p.value.id, { title: 'child', ownerUserId: 'usr_a' });
    if (!child.ok) throw new Error(child.message);
    await board.complete({ runId: cp.runId, leaseEpoch: cp.leaseEpoch, handoff: { summary: 'split' } });
    const row = state.storage.sql.exec(`SELECT pending_advance_json AS j FROM cards WHERE id = ?`, p.value.id).toArray()[0]!;
    expect(row.j).not.toBeNull();
    if (mutatePending) {
      state.storage.sql.exec(`UPDATE cards SET pending_advance_json = ? WHERE id = ?`, mutatePending(row.j as string), p.value.id);
    }
    const cc = await board.claim({ agentId: 'agt_c', capabilities: ['work'] });
    if (!cc.claimed || cc.card.id !== child.value.id) throw new Error('expected the child claim');
    await board.complete({ runId: cc.runId, leaseEpoch: cc.leaseEpoch, handoff: { summary: 'c' } });
    const childGate = (await board.getState()).gates.find((g) => g.cardId === child.value.id)!;
    const r = await board.resolveGate({ gateId: childGate.id, decision: 'approve', decidedBy: 'usr_reviewer' });
    expect(r.ok).toBe(true);
    return { parentId: p.value.id, parentRunId: cp.runId };
  };
  const parentGates = (state: DurableObjectState, parentId: string) =>
    state.storage.sql
      .exec(`SELECT stage_key, run_id, status FROM gates WHERE card_id = ?`, parentId)
      .toArray() as Array<{ stage_key: string; run_id: string | null; status: string }>;

  it('a gate opened by a deferred parent advance names the parent run', async () => {
    await runInDurableObject(stubFor('grid-deferred'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_grid4', tenantId: 'tnt_a', name: 'g', stages: DEFER });
      const { parentId, parentRunId } = await deferParentThenResolveChild(board, state);
      expect(parentGates(state, parentId)).toEqual([{ stage_key: 'review', run_id: parentRunId, status: 'pending' }]);
    });
  });

  it('a deferred advance recorded before runId was carried resumes with a null run_id', async () => {
    await runInDurableObject(stubFor('grid-deferred-legacy'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_grid5', tenantId: 'tnt_a', name: 'g', stages: DEFER });
      const { parentId } = await deferParentThenResolveChild(board, state, (json) => {
        const { runId: _dropped, ...legacy } = JSON.parse(json);
        return JSON.stringify(legacy);
      });
      expect(parentGates(state, parentId)).toEqual([{ stage_key: 'review', run_id: null, status: 'pending' }]);
    });
  });
});

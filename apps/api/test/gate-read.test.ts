import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { createAgent, createAgentToken } from '../src/db/catalog';

/**
 * `GET /v1/boards/:id/gates/:gateId` — one gate, including how it was decided.
 *
 * Gates were readable two ways and neither served the caller that needed this: `gates/pending`
 * answers only what is still waiting, and the board snapshot is a human route. So a hub that had
 * posted a gate into a Matrix room had no way to learn that the gate had since been decided on the
 * web, or what the decision was — and the room went on offering Approve and Reject for a decision
 * already made, indefinitely.
 *
 * Readable by an agent for the same reason `gates/pending` is: a gate names nobody and carries no
 * authority. Deciding one is still human-only.
 */
const PIPE: BoardInit['stages'] = [
  { key: 'work', name: 'Work', order: 0, ownerKind: 'capability', owner: 'code' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
];
const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('BoardDO — getGate', () => {
  it('returns a resolved gate with its decision, and 404s an unknown one', async () => {
    await runInDurableObject(stubFor('gate-read-1'), async (board: BoardDO) => {
      await board.init({ id: 'brd_g', tenantId: 'tnt_a', name: 'G', stages: PIPE });
      const c = await board.createCard({ title: 'Gated', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');

      const claim = await board.claim({ agentId: 'agt_1', capabilities: ['code'] });
      if (!claim.claimed) throw new Error('claim');
      await board.complete({ runId: claim.runId!, leaseEpoch: claim.leaseEpoch!, agentId: 'agt_1' });

      const snap = await board.getState();
      const gate = snap.gates.find((g) => g.status === 'pending');
      if (!gate) throw new Error('no gate opened');

      const before = await board.getGate(gate.id);
      if (!before.ok) throw new Error('read failed');
      expect(before.value).toMatchObject({ id: gate.id, status: 'pending', decision: null });

      await board.resolveGate({ gateId: gate.id, decision: 'approve', decidedBy: 'usr_h' });

      const after = await board.getGate(gate.id);
      if (!after.ok) throw new Error('read failed');
      // The part that did not exist: what the decision WAS, after it stopped being pending.
      expect(after.value).toMatchObject({ status: 'resolved', decision: 'approve', decidedBy: 'usr_h' });

      expect(await board.getGate('gate_missing')).toMatchObject({ ok: false, code: 'GATE_NOT_FOUND' });
    });
  });
});

describe('GET /v1/boards/:id/gates/:gateId', () => {
  it('answers with the gate, and 404s one that is not there', async () => {
    const board = await (
      await SELF.fetch('https://api.test/v1/boards', {
        method: 'POST',
        headers: dev('tnt_gate'),
        body: JSON.stringify({ name: 'Gate read', stages: PIPE }),
      })
    ).json<{ boardId: string }>();

    await SELF.fetch(`https://api.test/v1/boards/${board.boardId}/cards`, {
      method: 'POST',
      headers: dev('tnt_gate'),
      body: JSON.stringify({ title: 'Gated' }),
    });

    // A real agent and a real token: the claim predicate reads capabilities from the agents row,
    // so dev headers alone do not staff a stage.
    const agent = await createAgent(env.DB, 'tnt_gate', { name: 'Coder', capabilities: ['code'] });
    const { token } = await createAgentToken(env.DB, 'tnt_gate', agent.id, ['claim', 'run']);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const claim = await (
      await SELF.fetch(`https://api.test/v1/boards/${board.boardId}/claims`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json<{ claimed: boolean; runId?: string; leaseEpoch?: number }>();
    expect(claim.claimed).toBe(true);

    await SELF.fetch(`https://api.test/v1/boards/${board.boardId}/runs/${claim.runId}/complete`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ leaseEpoch: claim.leaseEpoch }),
    });

    const pending = await (
      await SELF.fetch(`https://api.test/v1/boards/${board.boardId}/gates/pending`, { headers: auth })
    ).json<{ gates: Array<{ gateId: string }> }>();
    expect(pending.gates.length).toBeGreaterThan(0);
    const gateId = pending.gates[0]!.gateId;

    const res = await SELF.fetch(`https://api.test/v1/boards/${board.boardId}/gates/${gateId}`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ gate: { id: string; status: string } }>()).gate).toMatchObject({
      id: gateId,
      status: 'pending',
    });

    const missing = await SELF.fetch(`https://api.test/v1/boards/${board.boardId}/gates/gate_nope`, {
      headers: auth,
    });
    expect(missing.status).toBe(404);
  });
});

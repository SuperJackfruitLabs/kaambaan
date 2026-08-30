/**
 * The read the hub's reconciliation sweep asks for.
 *
 * Push is at-least-once within a cap and then dead-letters. A gate whose
 * deliveries all die is a card blocked forever on an approval that never rang,
 * and nothing on either side is looking. `charter →
 * decisions/2026-08-30-a-gate-closes-over-chat.md` §5 calls the sweep the floor
 * beneath push; this is the half of it that lives on the board.
 *
 * **One builder, two transports.** The whole risk in a second way to send the
 * same thing is that the two drift and a gate reads differently depending on
 * which path delivered it. The first test here is the guard against that: it
 * asserts the swept body and the pushed body are the same bytes, not merely the
 * same shape.
 *
 * **Why this is an agent route.** The board snapshot already carries pending
 * gates, but `GET /v1/boards/:id` is a human route — the bridge's `kbn_` token
 * gets 401. The alternative was for the hub to mint a principal assertion on a
 * timer, which would break the property `service-signing.ts` rests on: the
 * subject of an assertion is never a parameter, it comes from a sender's mxid,
 * and a sweep has no sender. Asking "which gates are pending" is agent-shaped:
 * it reads, it names no one, and it carries no authority.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';

beforeAll(setupCatalog);

const REVIEW_PIPELINE: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
];

const HOOK = 'https://hub.example/public/bridge/kaambaan/push';

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

describe('BoardDO — the gates a sweep can find', () => {
  it('describes a pending gate in exactly the body a push carries', async () => {
    await runInDurableObject(stubFor('gs-same'), async (board: BoardDO) => {
      await board.init({ id: 'brd_gs', tenantId: 'tnt_a', name: 'G', stages: REVIEW_PIPELINE });
      await board.registerPushConfig({ agentId: 'a', url: HOOK, token: 's', events: ['gate.pending'] });
      await openGate(board, 'brd_gs');

      const pushed = JSON.parse((await board.getPushDeliveries())[0]!.body);
      const swept = await board.pendingGateDeliveries();

      // Same bytes, not merely the same shape. Two builders would let a swept
      // gate render differently from a pushed one, and the difference would
      // only ever be seen on the path that already failed once.
      expect(swept).toEqual([pushed]);
    });
  });

  it('is readable on a board that subscribes to no push at all', async () => {
    // The sweep must not depend on a push config existing: a board whose
    // subscription was never registered is exactly the case where every
    // delivery is missing and the sweep is the only floor left.
    await runInDurableObject(stubFor('gs-nopush'), async (board: BoardDO) => {
      const cardId = await openGate(board, 'brd_gn');
      expect(await board.getPushDeliveries()).toHaveLength(0);

      const swept = await board.pendingGateDeliveries();
      expect(swept).toHaveLength(1);
      expect(swept[0]).toMatchObject({
        event: 'gate.pending',
        boardId: 'brd_gn',
        cardId,
        stageKey: 'review',
        returnStageKey: 'research',
        cardTitle: 'Add OAuth login',
        producedBy: 'agt_r',
        handoffSummary: 'drafted',
      });
    });
  });

  it('stops naming a gate once it has been answered', async () => {
    await runInDurableObject(stubFor('gs-resolved'), async (board: BoardDO) => {
      await openGate(board, 'brd_gr');
      const gateId = (await board.pendingGateDeliveries())[0]!.gateId;

      await board.resolveGate({ gateId, decision: 'approve', decidedBy: 'usr_a' });

      // A resolved gate that kept appearing would be re-projected into the room
      // on every sweep, asking again for a decision already made.
      expect(await board.pendingGateDeliveries()).toEqual([]);
    });
  });
});

describe('GET /v1/boards/:id/gates/pending', () => {
  async function connectAgent(tenantId: string) {
    const agent = await createAgent(env.DB, tenantId, { name: 'The bridge', capabilities: [] });
    const { token } = await createAgentToken(env.DB, tenantId, agent.id, ['claim']);
    return token;
  }

  async function boardWithAGate(tenantId: string): Promise<string> {
    const res = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Gated', stages: REVIEW_PIPELINE }),
    });
    const boardId = ((await res.json()) as { boardId: string }).boardId;
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Add OAuth login', ownerUserId: 'usr_a' }),
    });
    const claimed = (await (
      await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
        method: 'POST',
        headers: { 'X-Tenant-Id': tenantId, 'X-Agent-Id': 'agt_r', 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: ['research'] }),
      })
    ).json()) as { runId: string; leaseEpoch: number };
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${claimed.runId}/complete`, {
      method: 'POST',
      headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseEpoch: claimed.leaseEpoch, handoff: { summary: 'drafted' } }),
    });
    return boardId;
  }

  it('answers a bridge holding only its own kbn_ token', async () => {
    // The reason this route exists. The board snapshot carries the same gates
    // and refuses this credential, which would leave the sweep with no way to
    // ask that does not involve asserting a person who is not there.
    const tenantId = 'tnt_sweep1';
    const boardId = await boardWithAGate(tenantId);
    const token = await connectAgent(tenantId);

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/gates/pending`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { gates: Array<Record<string, unknown>> };
    expect(body.gates).toHaveLength(1);
    expect(body.gates[0]).toMatchObject({ event: 'gate.pending', cardTitle: 'Add OAuth login' });
  });

  it('refuses a request carrying no credential at all', async () => {
    const tenantId = 'tnt_sweep2';
    const boardId = await boardWithAGate(tenantId);

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/gates/pending`);

    expect(res.status).toBe(401);
  });
});

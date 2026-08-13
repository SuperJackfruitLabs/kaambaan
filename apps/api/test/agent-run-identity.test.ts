import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';
import { connectMcp, depsFor, toolJson } from './helpers/mcp';
import { signSession } from '../src/auth/session';
import worker from '../src/index';
import type { Env } from '../src/env';
import type { BoardDO } from '../src/board/board-do';

/**
 * Run verbs are authorized by identity *and* the lease (docs/04 §1). The lease fences a stale
 * writer; it does not say *who* the writer is, so without an identity check any agent token in the
 * tenant could drive any other agent's run given `runId` + `leaseEpoch` — and `usage_records` would
 * meter the spend against the original `run.agent_id`. Per-service accountability depends on this.
 */

beforeAll(setupCatalog);

const STAGES = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
];

const base = 'https://api.test';
const FAR_FUTURE = 8_000_000_000_000; // well past any heartbeat deadline

async function createBoard(tenantId: string): Promise<string> {
  const res = await SELF.fetch(`${base}/v1/boards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Identity', stages: STAGES }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { boardId: string }).boardId;
}

async function addCard(tenantId: string, boardId: string, title: string): Promise<void> {
  const res = await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, ownerUserId: 'usr_a' }),
  });
  expect(res.status).toBe(201);
}

async function connectAgent(tenantId: string, capabilities: string[], name: string) {
  const agent = await createAgent(env.DB, tenantId, { name, capabilities });
  const { token } = await createAgentToken(env.DB, tenantId, agent.id, ['claim']);
  return { agentId: agent.id, token };
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function claim(boardId: string, token: string) {
  const res = await SELF.fetch(`${base}/v1/boards/${boardId}/claims`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { claimed: boolean; runId: string; leaseEpoch: number };
  expect(body.claimed).toBe(true);
  return body;
}

function verb(boardId: string, runId: string, action: string, token: string, body: Record<string, unknown>) {
  return SELF.fetch(`${base}/v1/boards/${boardId}/runs/${runId}/${action}`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body),
  });
}

function boardDo(tenantId: string, boardId: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(`${tenantId}:${boardId}`)) as unknown as DurableObjectStub<BoardDO>;
}

async function snapshot(tenantId: string, boardId: string) {
  const res = await SELF.fetch(`${base}/v1/boards/${boardId}`, { headers: { 'X-Tenant-Id': tenantId } });
  return (await res.json()) as {
    cards: Array<{ state: string; delegateAgentId: string | null }>;
    usage: { totalCostUsd: number };
  };
}

describe('run verbs check identity, not just the lease', () => {
  it('refuses every verb when the run belongs to another agent, and leaves the run untouched', async () => {
    const tenantId = 'tnt_id1';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'A’s work');
    const a = await connectAgent(tenantId, ['research'], 'Agent A');
    const b = await connectAgent(tenantId, ['research'], 'Agent B');
    const run = await claim(boardId, a.token);

    // B knows the runId and the lease epoch — the only things the lease check looks at.
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['heartbeat', {}],
      ['activities', { type: 'thought', body: 'hijacked' }],
      ['complete', { handoff: { summary: 'not mine' } }],
      ['submit', {}],
      ['block', { reason: 'nope' }],
      ['fail', { reason: 'nope' }],
      ['release', {}],
    ];
    for (const [action, body] of attempts) {
      const res = await verb(boardId, run.runId, action, b.token, { leaseEpoch: run.leaseEpoch, ...body });
      expect(res.status, `${action} must be refused`).toBe(403);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'NOT_RUN_OWNER' } });
    }

    // A still holds the card, in the state it was left in.
    const state = await snapshot(tenantId, boardId);
    expect(state.cards[0]).toMatchObject({ state: 'working', delegateAgentId: a.agentId });
  });

  it('lets the owning agent drive its own run end to end', async () => {
    const tenantId = 'tnt_id2';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Mine');
    const a = await connectAgent(tenantId, ['research'], 'Agent A');
    const run = await claim(boardId, a.token);

    expect((await verb(boardId, run.runId, 'heartbeat', a.token, { leaseEpoch: run.leaseEpoch })).status).toBe(200);
    expect(
      (await verb(boardId, run.runId, 'activities', a.token, { leaseEpoch: run.leaseEpoch, type: 'thought', body: 'on it' })).status,
    ).toBe(200);
    expect((await verb(boardId, run.runId, 'complete', a.token, { leaseEpoch: run.leaseEpoch })).status).toBe(200);

    const state = await snapshot(tenantId, boardId);
    expect(state.cards[0]!.state).toBe('submitted'); // advanced to the build stage, awaiting its agent
  });

  it('does not meter one agent’s spend against another', async () => {
    const tenantId = 'tnt_id3';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Billable');
    const a = await connectAgent(tenantId, ['research'], 'Agent A');
    const b = await connectAgent(tenantId, ['research'], 'Agent B');
    const run = await claim(boardId, a.token);

    // usage_records are attributed to run.agent_id — so a foreign activity would bill A for B's work.
    const res = await verb(boardId, run.runId, 'activities', b.token, {
      leaseEpoch: run.leaseEpoch,
      type: 'action',
      action: 'llm.call',
      usage: { model: 'claude-opus-4-8', inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 99 },
    });
    expect(res.status).toBe(403);
    expect((await snapshot(tenantId, boardId)).usage.totalCostUsd).toBe(0);
  });

  it('keeps reclaim working: the agent that re-claims drives the card, the zombie is fenced out', async () => {
    const tenantId = 'tnt_id4';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Reclaim me');
    const a = await connectAgent(tenantId, ['research'], 'Agent A');
    const b = await connectAgent(tenantId, ['research'], 'Agent B');

    const first = await claim(boardId, a.token);
    // A goes dark: its heartbeat lapses and the run is reclaimed, re-queuing the card.
    expect(await boardDo(tenantId, boardId).reclaimExpired(FAR_FUTURE)).toBe(1);

    // B legitimately re-claims — a new run, a new lease epoch, and B is now the card's delegate.
    const second = await claim(boardId, b.token);
    expect(second.runId).not.toBe(first.runId);
    expect(second.leaseEpoch).toBeGreaterThan(first.leaseEpoch);
    expect((await snapshot(tenantId, boardId)).cards[0]!.delegateAgentId).toBe(b.agentId);

    // B drives the run it now holds — the identity check must not stand in the way of a reclaim.
    expect((await verb(boardId, second.runId, 'heartbeat', b.token, { leaseEpoch: second.leaseEpoch })).status).toBe(200);
    expect((await verb(boardId, second.runId, 'complete', b.token, { leaseEpoch: second.leaseEpoch })).status).toBe(200);

    // A wakes up and pushes on its own (now-ended) run: fencing still answers 409, not 403 —
    // "your lease lapsed, re-claim", which is what a well-behaved agent acts on.
    const zombie = await verb(boardId, first.runId, 'heartbeat', a.token, { leaseEpoch: first.leaseEpoch });
    expect(zombie.status).toBe(409);
    expect((await zombie.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'STALE_LEASE' } });

    // …and A cannot reach B's run either.
    expect((await verb(boardId, second.runId, 'heartbeat', a.token, { leaseEpoch: second.leaseEpoch })).status).toBe(403);
  });

  it('still fences a stale lease on the agent’s own run', async () => {
    const tenantId = 'tnt_id5';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Fencing');
    const a = await connectAgent(tenantId, ['research'], 'Agent A');
    const run = await claim(boardId, a.token);
    const res = await verb(boardId, run.runId, 'heartbeat', a.token, { leaseEpoch: run.leaseEpoch + 99 });
    expect(res.status).toBe(409);
  });

  it('applies the same rule on the MCP surface', async () => {
    const tenantId = 'tnt_id6';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'MCP work');
    const a = { tenantId, agentId: 'agt_mcp_a', capabilities: ['research'] };
    const b = { tenantId, agentId: 'agt_mcp_b', capabilities: ['research'] };

    const clientA = await connectMcp(depsFor(a));
    const claimed = toolJson(await clientA.callTool({ name: 'kaambaan_claim_card', arguments: { boardId } })) as {
      runId: string;
      leaseEpoch: number;
    };

    const clientB = await connectMcp(depsFor(b));
    const hijack = await clientB.callTool({
      name: 'kaambaan_complete',
      arguments: { boardId, runId: claimed.runId, leaseEpoch: claimed.leaseEpoch },
    });
    expect(hijack.isError).toBe(true);
    expect(toolJson(hijack)).toMatchObject({ error: { code: 'NOT_RUN_OWNER' } });

    // A's own call still works.
    const own = await clientA.callTool({
      name: 'kaambaan_complete',
      arguments: { boardId, runId: claimed.runId, leaseEpoch: claimed.leaseEpoch },
    });
    expect(own.isError).toBeFalsy();
  });

  it('is not reachable by a human session at all — run verbs take an agent token', async () => {
    const tenantId = 'tnt_id7';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Human?');
    const a = await connectAgent(tenantId, ['research'], 'Agent A');
    const run = await claim(boardId, a.token);

    const deployed = { ...env, DEV_AUTH: undefined, SESSION_SECRET: 'test-session-secret' } as unknown as Env;
    const cookie = await signSession({ userId: 'usr_a', tenantId, exp: Date.now() + 60_000 }, 'test-session-secret');
    const res = await worker.fetch(
      new Request(`${base}/v1/boards/${boardId}/runs/${run.runId}/complete`, {
        method: 'POST',
        headers: { Cookie: `kaambaan_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaseEpoch: run.leaseEpoch }),
      }),
      deployed,
    );
    // A human moves work with the human verbs (move a card, resolve a gate), never by driving a run.
    expect(res.status).toBe(401);
  });
});

import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';

/**
 * The elicitation return path over the wire (docs/04 §3, docs/05 §3).
 *
 * Two surfaces meet here and they are deliberately different: the **human** answers through a
 * session-authenticated board route, and the **agent** collects the answer by re-reading the run it
 * already holds (`GET /v1/boards/:id/runs/:runId`) — the read surface added for run-scoped agent
 * reads. The agent needs no human credential and no new authorization rule to be unblocked.
 */

beforeAll(setupCatalog);

const base = 'https://api.test';
const STAGES = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
];
const OPTIONS = [
  { name: 'run_them', title: 'Run the tests' },
  { name: 'skip', title: 'Skip them' },
];

function human(tenantId: string, userId?: string): Record<string, string> {
  const h: Record<string, string> = { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' };
  if (userId) h['X-User-Id'] = userId;
  return h;
}

function agentAuth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function createBoard(tenantId: string): Promise<string> {
  const res = await SELF.fetch(`${base}/v1/boards`, {
    method: 'POST',
    headers: human(tenantId),
    body: JSON.stringify({ name: 'Elicitations', stages: STAGES }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { boardId: string }).boardId;
}

async function addCard(tenantId: string, boardId: string, title: string): Promise<void> {
  const res = await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: human(tenantId),
    body: JSON.stringify({ title, ownerUserId: 'usr_a' }),
  });
  expect(res.status).toBe(201);
}

async function connectAgent(tenantId: string, capabilities: string[], name: string) {
  const agent = await createAgent(env.DB, tenantId, { name, capabilities });
  const { token } = await createAgentToken(env.DB, tenantId, agent.id, ['claim']);
  return { agentId: agent.id, token };
}

/** Claim a card with a real agent token and stop on a question that needs a human. */
async function claimAndAsk(boardId: string, token: string) {
  const claimRes = await SELF.fetch(`${base}/v1/boards/${boardId}/claims`, {
    method: 'POST',
    headers: agentAuth(token),
    body: JSON.stringify({}),
  });
  const claim = (await claimRes.json()) as { claimed: boolean; runId: string; leaseEpoch: number };
  expect(claim.claimed).toBe(true);
  const asked = await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${claim.runId}/activities`, {
    method: 'POST',
    headers: agentAuth(token),
    body: JSON.stringify({
      leaseEpoch: claim.leaseEpoch,
      type: 'elicitation',
      body: 'May I run the test suite?',
      signal: 'select',
      parameter: { options: OPTIONS },
    }),
  });
  expect(asked.status).toBe(200);
  return claim;
}

/** What the agent sees when it polls the run it holds. */
async function pollRun(boardId: string, runId: string, token: string) {
  const res = await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${runId}`, { headers: agentAuth(token) });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    card: { state: string };
    elicitations: Array<{
      id: string;
      question: string;
      options: Array<{ name: string; title: string }>;
      status: string;
      answer: { option: string | null; text: string | null; answeredBy: string } | null;
    }>;
  };
}

function answer(boardId: string, elicitationId: string, headers: Record<string, string>, body: unknown) {
  return SELF.fetch(`${base}/v1/boards/${boardId}/elicitations/${elicitationId}/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('a human answers an agent’s question over REST', () => {
  it('unblocks the agent: the card returns to working and the answer is on the run it polls', async () => {
    const tenantId = 'tnt_elc1';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Ship the change');
    const agent = await connectAgent(tenantId, ['research'], 'Researcher');
    const claim = await claimAndAsk(boardId, agent.token);

    // The agent polls and finds its own question, still pending.
    const waiting = await pollRun(boardId, claim.runId, agent.token);
    expect(waiting.card.state).toBe('input-required');
    expect(waiting.elicitations).toHaveLength(1);
    expect(waiting.elicitations[0]).toMatchObject({ question: 'May I run the test suite?', status: 'pending' });
    expect(waiting.elicitations[0]!.options).toEqual(OPTIONS);
    const elicitationId = waiting.elicitations[0]!.id;

    // A signed-in human answers.
    const res = await answer(boardId, elicitationId, human(tenantId, 'usr_h'), { option: 'run_them' });
    expect(res.status).toBe(200);
    const answered = (await res.json()) as { card: { state: string }; elicitation: { status: string } };
    expect(answered.card.state).toBe('working');
    expect(answered.elicitation.status).toBe('answered');

    // The next poll — the same request the agent was already making — carries the decision.
    const resumed = await pollRun(boardId, claim.runId, agent.token);
    expect(resumed.card.state).toBe('working');
    expect(resumed.elicitations[0]).toMatchObject({ status: 'answered' });
    expect(resumed.elicitations[0]!.answer).toMatchObject({ option: 'run_them', answeredBy: 'usr_h' });

    // …and the agent can carry on driving the run it never let go of.
    const done = await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${claim.runId}/complete`, {
      method: 'POST',
      headers: agentAuth(agent.token),
      body: JSON.stringify({ leaseEpoch: claim.leaseEpoch, handoff: { summary: 'tests ran' } }),
    });
    expect(done.status).toBe(200);
  });

  it('shows the pending question on the board snapshot the human is looking at', async () => {
    const tenantId = 'tnt_elc2';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Snapshot');
    const agent = await connectAgent(tenantId, ['research'], 'Researcher');
    await claimAndAsk(boardId, agent.token);

    const snap = (await (await SELF.fetch(`${base}/v1/boards/${boardId}`, { headers: human(tenantId) })).json()) as {
      elicitations: Array<{ id: string; question: string; status: string }>;
    };
    expect(snap.elicitations).toHaveLength(1);
    expect(snap.elicitations[0]).toMatchObject({ question: 'May I run the test suite?', status: 'pending' });
  });
});

describe('who may answer, over the wire', () => {
  it('refuses the asking agent’s own token — the answer route is not an agent route', async () => {
    const tenantId = 'tnt_elc3';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Self-answer');
    const agent = await connectAgent(tenantId, ['research'], 'Researcher');
    const claim = await claimAndAsk(boardId, agent.token);
    const elicitationId = (await pollRun(boardId, claim.runId, agent.token)).elicitations[0]!.id;

    const res = await answer(boardId, elicitationId, agentAuth(agent.token), { option: 'run_them' });
    expect(res.status).toBe(401);
    expect((await pollRun(boardId, claim.runId, agent.token)).card.state).toBe('input-required');
  });

  it('refuses the asking agent’s identity even when it arrives as a human principal', async () => {
    const tenantId = 'tnt_elc4';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Impersonation');
    const agent = await connectAgent(tenantId, ['research'], 'Researcher');
    const claim = await claimAndAsk(boardId, agent.token);
    const elicitationId = (await pollRun(boardId, claim.runId, agent.token)).elicitations[0]!.id;

    const res = await answer(boardId, elicitationId, human(tenantId, agent.agentId), { option: 'run_them' });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'SEPARATION_OF_DUTIES' },
    });
  });

  it('refuses an unauthenticated answer', async () => {
    const tenantId = 'tnt_elc5';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Anonymous');
    const agent = await connectAgent(tenantId, ['research'], 'Researcher');
    const claim = await claimAndAsk(boardId, agent.token);
    const elicitationId = (await pollRun(boardId, claim.runId, agent.token)).elicitations[0]!.id;

    const res = await answer(boardId, elicitationId, { 'Content-Type': 'application/json' }, { option: 'run_them' });
    expect(res.status).toBe(401);
  });

  it('answers once: a second answer is a 409 conflict, not a second transition', async () => {
    const tenantId = 'tnt_elc6';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Double click');
    const agent = await connectAgent(tenantId, ['research'], 'Researcher');
    const claim = await claimAndAsk(boardId, agent.token);
    const elicitationId = (await pollRun(boardId, claim.runId, agent.token)).elicitations[0]!.id;

    expect((await answer(boardId, elicitationId, human(tenantId, 'usr_h'), { option: 'run_them' })).status).toBe(200);
    const again = await answer(boardId, elicitationId, human(tenantId, 'usr_other'), { option: 'skip' });
    expect(again.status).toBe(409);
    expect((await again.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ELICITATION_NOT_PENDING' },
    });
    const state = await pollRun(boardId, claim.runId, agent.token);
    expect(state.card.state).toBe('working');
    expect(state.elicitations[0]!.answer).toMatchObject({ option: 'run_them', answeredBy: 'usr_h' });
  });

  it('404s an unknown elicitation and 400s an answer outside the offered options', async () => {
    const tenantId = 'tnt_elc7';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Bad input');
    const agent = await connectAgent(tenantId, ['research'], 'Researcher');
    const claim = await claimAndAsk(boardId, agent.token);
    const elicitationId = (await pollRun(boardId, claim.runId, agent.token)).elicitations[0]!.id;

    expect((await answer(boardId, 'elc_nope', human(tenantId, 'usr_h'), { option: 'run_them' })).status).toBe(404);
    expect((await answer(boardId, elicitationId, human(tenantId, 'usr_h'), { option: 'rm_-rf' })).status).toBe(400);
  });

  it('does not leak another agent’s question through the run read surface', async () => {
    const tenantId = 'tnt_elc8';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Not yours');
    const asker = await connectAgent(tenantId, ['research'], 'Asker');
    const other = await connectAgent(tenantId, ['research'], 'Other');
    const claim = await claimAndAsk(boardId, asker.token);

    const res = await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${claim.runId}`, { headers: agentAuth(other.token) });
    expect(res.status).toBe(403);
  });
});

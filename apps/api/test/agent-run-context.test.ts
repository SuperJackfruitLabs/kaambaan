import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';
import { KaambaanAgent, type Fetcher } from '@kaambaan/agent-sdk';
import { signSession } from '../src/auth/session';
import worker from '../src/index';
import type { Env } from '../src/env';

/**
 * The agent read surface (docs/04 §3 `getCard`, docs/05 §3): an agent authenticated with a `kbn_`
 * token can read the context of **its own run** — the card it claimed, that card's stage, the
 * upstream handoff and the card's references — and nothing else. Everything here goes over the
 * real production credential (a token), never the dev headers.
 */

beforeAll(setupCatalog);

const STAGES = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
];

const base = 'https://api.test';
const fetcher: Fetcher = (url, init) => SELF.fetch(url, init);

/** A human (dev header) sets the board up — agent tokens can't create boards or cards. */
async function createBoard(tenantId: string, name = 'Read surface'): Promise<string> {
  const res = await SELF.fetch(`${base}/v1/boards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, stages: STAGES }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { boardId: string }).boardId;
}

async function addCard(tenantId: string, boardId: string, title: string): Promise<string> {
  const res = await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, ownerUserId: 'usr_a', spec: { goal: 'summarize the incident reports' } }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { card: { id: string } }).card.id;
}

/** Register a real agent + mint its `kbn_` token, exactly as "Connect an agent" does. */
async function connectAgent(tenantId: string, capabilities: string[], name = 'Reader') {
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
  return (await res.json()) as { claimed: boolean; runId: string; leaseEpoch: number };
}

function readRun(boardId: string, runId: string, token: string) {
  return SELF.fetch(`${base}/v1/boards/${boardId}/runs/${runId}`, { headers: auth(token) });
}

describe('agent read surface — GET /v1/boards/:id/runs/:runId', () => {
  it('gives the claiming agent its card, stage, handoff and references', async () => {
    const tenantId = 'tnt_read1';
    const boardId = await createBoard(tenantId);
    const cardId = await addCard(tenantId, boardId, 'Summarize incidents');
    // A reference a human attached — part of the context the agent needs to act.
    await SELF.fetch(`${base}/v1/boards/${boardId}/cards/${cardId}/references`, {
      method: 'PUT',
      headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/rakeshgangwar/kaambaan/issues/1' }),
    });
    const { token } = await connectAgent(tenantId, ['research']);
    const claimed = await claim(boardId, token);
    expect(claimed.claimed).toBe(true);

    const res = await readRun(boardId, claimed.runId, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { runId: string; cardId: string; stageKey: string; leaseEpoch: number; status: string };
      card: { id: string; title: string; spec: unknown; state: string };
      stage: { key: string; name: string };
      handoff: unknown;
      references: Array<{ url: string }>;
    };

    expect(body.run).toMatchObject({
      runId: claimed.runId,
      cardId,
      stageKey: 'research',
      leaseEpoch: claimed.leaseEpoch,
      status: 'working',
    });
    expect(body.card).toMatchObject({ id: cardId, title: 'Summarize incidents', state: 'working' });
    expect(body.card.spec).toEqual({ goal: 'summarize the incident reports' });
    expect(body.stage).toMatchObject({ key: 'research', name: 'Research' });
    expect(body.references.map((r) => r.url)).toEqual(['https://github.com/rakeshgangwar/kaambaan/issues/1']);
  });

  it('carries the upstream handoff so a later stage can act on it', async () => {
    const tenantId = 'tnt_read2';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Two stages');
    const researcher = await connectAgent(tenantId, ['research'], 'Researcher');
    const builder = await connectAgent(tenantId, ['build'], 'Builder');

    const first = await claim(boardId, researcher.token);
    await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${first.runId}/complete`, {
      method: 'POST',
      headers: auth(researcher.token),
      body: JSON.stringify({ leaseEpoch: first.leaseEpoch, handoff: { summary: 'researched' } }),
    });

    const second = await claim(boardId, builder.token);
    const body = (await (await readRun(boardId, second.runId, builder.token)).json()) as {
      stage: { key: string };
      handoff: { summary: string };
    };
    expect(body.stage.key).toBe('build');
    expect(body.handoff).toEqual({ summary: 'researched' });
  });

  it('still reads after the run ends, so an agent can verify the outcome it produced', async () => {
    const tenantId = 'tnt_read3';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Finish me');
    const { token } = await connectAgent(tenantId, ['research']);
    const claimed = await claim(boardId, token);
    await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${claimed.runId}/complete`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ leaseEpoch: claimed.leaseEpoch }),
    });

    const res = await readRun(boardId, claimed.runId, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { status: string; outcome: string }; card: { currentStageKey: string; state: string } };
    expect(body.run).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(body.card).toMatchObject({ currentStageKey: 'build', state: 'submitted' });
  });

  it('refuses another agent in the same tenant with 403 — a board is shared, a run is not', async () => {
    const tenantId = 'tnt_read4';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Mine, not yours');
    const mine = await connectAgent(tenantId, ['research'], 'Mine');
    const other = await connectAgent(tenantId, ['research'], 'Other');
    const claimed = await claim(boardId, mine.token);

    const res = await readRun(boardId, claimed.runId, other.token);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'NOT_RUN_OWNER' } });
  });

  it('404s an unknown run', async () => {
    const tenantId = 'tnt_read5';
    const boardId = await createBoard(tenantId);
    const { token } = await connectAgent(tenantId, ['research']);
    const res = await readRun(boardId, 'run_nope', token);
    expect(res.status).toBe(404);
  });

  it('cannot read a run on another tenant’s board of the same id (the token fixes the tenant)', async () => {
    const boardId = await createBoard('tnt_read6');
    await addCard('tnt_read6', boardId, 'Not yours');
    const insider = await connectAgent('tnt_read6', ['research'], 'Insider');
    const claimed = await claim(boardId, insider.token);

    // Same board id, same run id — but a token from a different tenant resolves a different DO.
    const outsider = await connectAgent('tnt_read6_other', ['research'], 'Outsider');
    const res = await readRun(boardId, claimed.runId, outsider.token);
    expect(res.status).toBe(404);
  });

  it('requires an agent token — a human session (and no credential) is refused', async () => {
    const tenantId = 'tnt_read7';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Human?');
    const { token } = await connectAgent(tenantId, ['research']);
    const claimed = await claim(boardId, token);
    const url = `${base}/v1/boards/${boardId}/runs/${claimed.runId}`;

    // A deployed environment: no dev headers, a real session secret.
    const deployed = { ...env, DEV_AUTH: undefined, SESSION_SECRET: 'test-session-secret' } as unknown as Env;
    const cookie = await signSession(
      { userId: 'usr_a', tenantId, exp: Date.now() + 60_000 },
      'test-session-secret',
    );

    // A signed-in human is not an agent: run routes take a token, and a session isn't one. Humans
    // read the same facts (and more) through the board snapshot.
    const human = await worker.fetch(new Request(url, { headers: { Cookie: `kaambaan_session=${cookie}` } }), deployed);
    expect(human.status).toBe(401);
    // And no credential at all is refused too.
    expect((await worker.fetch(new Request(url), deployed)).status).toBe(401);
  });

  it('is reachable through the shipped SDK with only a token (the AgentPod bridge path)', async () => {
    const tenantId = 'tnt_read9';
    const boardId = await createBoard(tenantId);
    const cardId = await addCard(tenantId, boardId, 'Bridge me');
    const mine = await connectAgent(tenantId, ['research'], 'Bridge');
    const other = await connectAgent(tenantId, ['research'], 'Intruder');

    const sdk = new KaambaanAgent({ baseUrl: base, boardId, token: mine.token, fetch: fetcher });
    const work = await sdk.claim();
    if (!work) throw new Error('expected work');

    const context = await sdk.context(work);
    expect(context.card.id).toBe(cardId);
    expect(context.stage?.key).toBe('research');

    // …and only for its own run.
    const intruder = new KaambaanAgent({ baseUrl: base, boardId, token: other.token, fetch: fetcher });
    await expect(intruder.context(work)).rejects.toMatchObject({ status: 403 });
  });

  it('does not widen the token: the whole-board snapshot stays human-only', async () => {
    const tenantId = 'tnt_read8';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Other work');
    const { token } = await connectAgent(tenantId, ['research']);

    // The board snapshot (every card, gate, cost total and the github config) is not agent-readable.
    expect((await SELF.fetch(`${base}/v1/boards/${boardId}`, { headers: auth(token) })).status).toBe(401);
    // Nor is the card list / a card by id, so an agent cannot enumerate a shared board.
    expect((await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, { headers: auth(token) })).status).toBe(401);
    expect((await SELF.fetch(`${base}/v1/boards`, { headers: auth(token) })).status).toBe(401);
  });
});

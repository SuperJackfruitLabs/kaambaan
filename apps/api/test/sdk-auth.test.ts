import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { KaambaanAgent, runOnce, KaambaanApiError, type Fetcher } from '@kaambaan/agent-sdk';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';

// The SDK must be able to authenticate the way the deployed server actually authenticates agents:
// a `kbn_` bearer token (agent_tokens.token_hash), not the dev-only X-Tenant-Id / X-Agent-Id
// headers. Everything here goes through @kaambaan/agent-sdk — no hand-rolled requests.

beforeAll(setupCatalog);

const STAGES = [{ key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' }];

const fetcher: Fetcher = (url, init) => SELF.fetch(url, init);

/** Records every request the SDK makes, so we can assert what it puts on the wire. */
function recordingFetcher(): { fetch: Fetcher; sent: Array<{ url: string; headers: Record<string, string> }> } {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  return {
    sent,
    fetch: (url, init) => {
      sent.push({ url, headers: init.headers });
      return SELF.fetch(url, init);
    },
  };
}

/** A human (dev-header) sets the board up — agent tokens can't create boards or cards. */
async function createBoard(tenantId: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Token board', stages: STAGES }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { boardId: string }).boardId;
}

async function addCard(tenantId: string, boardId: string, title: string): Promise<void> {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, ownerUserId: 'usr_a' }),
  });
  expect(res.status).toBe(201);
}

async function snapshot(tenantId: string, boardId: string) {
  return (await (
    await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: { 'X-Tenant-Id': tenantId } })
  ).json()) as { cards: Array<{ state: string; delegateAgentId: string | null }> };
}

/** Register a real agent + mint its `kbn_` token, exactly as the "connect an agent" flow does. */
async function connectAgent(tenantId: string, capabilities: string[]) {
  const agent = await createAgent(env.DB, tenantId, { name: 'SDK agent', capabilities });
  const { token } = await createAgentToken(env.DB, tenantId, agent.id, ['claim']);
  return { agentId: agent.id, token };
}

describe('agent SDK — kbn_ bearer auth', () => {
  it('drives a full run with only a token (no tenant/agent headers)', async () => {
    const tenantId = 'tnt_sdk1';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Token-authenticated work');
    const { token } = await connectAgent(tenantId, ['research']);

    const recorder = recordingFetcher();
    const agent = new KaambaanAgent({ baseUrl: 'https://api.test', boardId, token, fetch: recorder.fetch });

    expect(await runOnce(agent, async () => ({ done: true }))).toBe(true);

    const state = await snapshot(tenantId, boardId);
    expect(state.cards[0]!.state).toBe('completed');

    expect(recorder.sent.length).toBeGreaterThan(0);
    for (const req of recorder.sent) {
      expect(req.headers['Authorization']).toBe(`Bearer ${token}`);
      expect(req.headers['X-Tenant-Id']).toBeUndefined();
      expect(req.headers['X-Agent-Id']).toBeUndefined();
    }
  });

  it('takes identity and capabilities from the token, not from the client', async () => {
    const tenantId = 'tnt_sdk2';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Research this');
    // The client never states an agent id or capabilities — both come off the token's agent.
    const { agentId, token } = await connectAgent(tenantId, ['research']);

    const agent = new KaambaanAgent({ baseUrl: 'https://api.test', boardId, token, fetch: fetcher });
    expect(await agent.claim()).not.toBeNull();
    expect((await snapshot(tenantId, boardId)).cards[0]!.delegateAgentId).toBe(agentId);
  });

  it('raises a clear error on a rejected token instead of looking idle', async () => {
    const tenantId = 'tnt_sdk3';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Unreachable');

    const agent = new KaambaanAgent({
      baseUrl: 'https://api.test',
      boardId,
      token: 'kbn_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      fetch: fetcher,
    });

    await expect(agent.claim()).rejects.toThrow(KaambaanApiError);
    await expect(agent.claim()).rejects.toMatchObject({ status: 401 });
  });

  it('cannot reach another tenant’s board (the token fixes the tenant)', async () => {
    const boardId = await createBoard('tnt_sdk4');
    await addCard('tnt_sdk4', boardId, 'Not yours');
    const { token } = await connectAgent('tnt_other', ['research']);

    const agent = new KaambaanAgent({ baseUrl: 'https://api.test', boardId, token, fetch: fetcher });
    // Same board id, different tenant → a different Board DO, which has no such card.
    expect(await agent.claim()).toBeNull();
  });

  it('rejects a malformed token at construction', () => {
    const config = { baseUrl: 'https://api.test', boardId: 'brd_1', fetch: fetcher };
    expect(() => new KaambaanAgent({ ...config, token: 'not-a-kaambaan-token' })).toThrow(/kbn_/);
  });

  it('requires either a token or (dev) a tenant id', () => {
    expect(() => new KaambaanAgent({ baseUrl: 'https://api.test', boardId: 'brd_1', fetch: fetcher })).toThrow(/token/);
  });
});

describe('agent SDK — dev headers (local only)', () => {
  it('still works when no token is configured', async () => {
    const tenantId = 'tnt_sdk5';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId, 'Dev-mode work');

    const recorder = recordingFetcher();
    const agent = new KaambaanAgent({
      baseUrl: 'https://api.test',
      boardId,
      tenantId,
      agentId: 'agt_dev',
      capabilities: ['research'],
      fetch: recorder.fetch,
    });

    expect(await runOnce(agent, async () => undefined)).toBe(true);
    expect((await snapshot(tenantId, boardId)).cards[0]!.state).toBe('completed');
    expect(recorder.sent[0]!.headers['X-Tenant-Id']).toBe(tenantId);
    expect(recorder.sent[0]!.headers['Authorization']).toBeUndefined();
  });
});

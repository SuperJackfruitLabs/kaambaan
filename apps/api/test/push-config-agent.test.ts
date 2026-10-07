/**
 * An agent registers its own push subscription, with its own token.
 *
 * `POST /v1/boards/:id/push-configs` was a human route — a session cookie, with the subscriber
 * named by a caller-asserted `X-Agent-Id`. The only party that ever needs a subscription is the
 * hub's bridge, which holds an agent credential and nothing else, so nobody registered one: every
 * production board's `push_deliveries` stayed empty and a gate reached the room only when the
 * hub's five-minute sweep found it. docs/05 §4 says a config is "registered per agent/board" —
 * this is the route that makes that literally true.
 */
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';

beforeAll(setupCatalog);

const HOOK = 'https://hub.example/public/bridge/superpipeline/push';
const base = 'https://api.test';

const REVIEW_PIPELINE = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
];

async function boardFor(tenantId: string): Promise<string> {
  const res = await SELF.fetch(`${base}/v1/boards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Gated', stages: REVIEW_PIPELINE }),
  });
  return ((await res.json()) as { boardId: string }).boardId;
}

async function openGate(tenantId: string, boardId: string): Promise<void> {
  const h = { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' };
  await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ title: 'Add OAuth login', ownerUserId: 'usr_a' }),
  });
  const claimed = (await (
    await SELF.fetch(`${base}/v1/boards/${boardId}/claims`, {
      method: 'POST',
      headers: { ...h, 'X-Agent-Id': 'agt_r' },
      body: JSON.stringify({ capabilities: ['research'] }),
    })
  ).json()) as { runId: string; leaseEpoch: number };
  await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${claimed.runId}/complete`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ leaseEpoch: claimed.leaseEpoch, handoff: { summary: 'drafted' } }),
  });
}

async function tokenFor(tenantId: string, scopes: string[]): Promise<string> {
  const agent = await createAgent(env.DB, tenantId, { name: 'The bridge', capabilities: [] });
  return (await createAgentToken(env.DB, tenantId, agent.id, scopes as never)).token;
}

function register(boardId: string, token: string, extra: Record<string, string> = {}) {
  return SELF.fetch(`${base}/v1/boards/${boardId}/push-configs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ url: HOOK, token: 'shared-secret', events: ['gate.pending', 'elicitation.pending'] }),
  });
}

/** The config id of a registration that must have succeeded — a refusal is not a vacuous match. */
async function configIdOf(res: Response): Promise<string> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { configId: string }).configId;
}

describe('POST /v1/boards/:id/push-configs with an agent token', () => {
  it('registers a subscription that a gate opening then delivers to', async () => {
    const tenantId = 'tnt_pushagent1';
    const boardId = await boardFor(tenantId);
    const token = await tokenFor(tenantId, ['claim', 'run']);

    const res = await register(boardId, token);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { configId: string }).configId).toMatch(/^push_/);

    await openGate(tenantId, boardId);

    const deliveries = (
      (await (
        await SELF.fetch(`${base}/v1/boards/${boardId}/push/deliveries`, { headers: { 'X-Tenant-Id': tenantId } })
      ).json()) as { deliveries: Array<{ url: string; body: string }> }
    ).deliveries;
    expect(deliveries.map((d) => [d.url, JSON.parse(d.body).event])).toEqual([[HOOK, 'gate.pending']]);
  });

  it('is idempotent: registering again replaces the subscription rather than adding one', async () => {
    const tenantId = 'tnt_pushagent2';
    const boardId = await boardFor(tenantId);
    const token = await tokenFor(tenantId, ['claim']);

    const first = await configIdOf(await register(boardId, token));
    const second = await configIdOf(await register(boardId, token));
    expect(second).toBe(first);
  });

  it('subscribes the token’s agent, not whichever agent a header names', async () => {
    const tenantId = 'tnt_pushagent3';
    const boardId = await boardFor(tenantId);
    const token = await tokenFor(tenantId, ['claim']);

    // Two registrations of the same URL under the same authenticated agent are one config, whatever
    // the header claims. Were the header the identity, these would be two configs.
    const a = await configIdOf(await register(boardId, token, { 'X-Agent-Id': 'agt_one' }));
    const b = await configIdOf(await register(boardId, token, { 'X-Agent-Id': 'agt_two' }));
    expect(b).toBe(a);
  });

  it('refuses a token that may not claim', async () => {
    const tenantId = 'tnt_pushagent6';
    const boardId = await boardFor(tenantId);
    const readOnly = await tokenFor(tenantId, ['read']);

    expect((await register(boardId, readOnly)).status).toBe(403);
  });

  it('refuses a token from another tenant', async () => {
    const boardId = await boardFor('tnt_pushagent4');
    const foreign = await tokenFor('tnt_pushagent_other', ['claim']);

    const res = await register(boardId, foreign);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(201);
  });

  it('refuses a request carrying no credential', async () => {
    const boardId = await boardFor('tnt_pushagent5');
    const res = await SELF.fetch(`${base}/v1/boards/${boardId}/push-configs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: HOOK, token: 's' }),
    });
    expect(res.status).toBe(401);
  });
});

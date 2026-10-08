import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { withOrgPlane, planeToken } from './helpers/org-plane';
import { ensureCapabilities } from '../src/db/capabilities';
import { createAgent, createAgentToken, setAgentExternalMapping, findTenantByExternal } from '../src/db/catalog';

/**
 * The three operator acts `supi` could not reach: defining a capability, creating an agent linked
 * to a principal, and minting an agent's tokens.
 *
 * Each lived behind a session cookie only, so a person at a terminal — holding the same org-plane
 * token the web app's sign-in is built on — was answered 401. These hold the widening to exactly
 * what was asked for:
 *
 *   - a HUMAN org-plane bearer is admitted, with the role check the cookie path has always made
 *     (`manage`: admin or owner);
 *   - a member is refused, as on the cookie path;
 *   - an AGENT is refused by name (403) on all three, whatever credential it carries — an `spa_`
 *     token or an agent-kind org-plane token. An agent must never mint credentials or link agents to
 *     principals: that is the human half of the control pair.
 */

beforeAll(setupCatalog);

/**
 * Each test gets its own org and principals: D1 state persists across the tests in this file, and
 * a principal is one agent (`agents_external_pair_unique`).
 */
let seq = 0;
function ids() {
  const n = (++seq).toString(16).padStart(2, '0');
  const p = (x: string) => `prn_0000000000000000${n}${x}`;
  return { org: `org_0000000000000000c0${n}`, owner: p('01'), member: p('02'), agent: p('03'), newAgent: p('04'), other: p('05') };
}
let cur = ids();
const owner = () => planeToken({ org: cur.org, sub: cur.owner, email: `owner-${cur.org}@example.com` });
const member = () => planeToken({ org: cur.org, sub: cur.member, email: `member-${cur.org}@example.com` });
const planeAgent = () => planeToken({ org: cur.org, sub: cur.agent, principalKind: 'agent', email: undefined, email_verified: undefined, scope: 'claim run read' });

function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`https://api.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The tenant, its owner (first sight), a member (second sight), and two agent credentials in it. */
async function workspace(): Promise<{ tenantId: string; spa: string; agentId: string; capId: string }> {
  cur = ids();
  // First sight makes the owner; the second person to arrive is a member.
  expect((await call('GET', '/v1/boards', await owner())).status).toBe(200);
  expect((await call('GET', '/v1/boards', await member())).status).toBe(200);
  const tenantId = (await findTenantByExternal(env.DB, 'org-plane', cur.org))!;
  await ensureCapabilities(env.DB, tenantId, ['code'], null);

  const existing = await createAgent(env.DB, tenantId, { name: 'worker', capabilities: ['code'] });
  const { token: spa } = await createAgentToken(env.DB, tenantId, existing.id, ['claim', 'run']);
  const linked = await createAgent(env.DB, tenantId, { name: 'linked', capabilities: ['code'] });
  await setAgentExternalMapping(env.DB, tenantId, linked.id, { externalId: cur.agent, externalSource: 'org-plane' });

  const caps = (await (await call('GET', '/v1/capabilities', await owner())).json()) as { capabilities: Array<{ id: string; key: string }> };
  const capId = caps.capabilities.find((c) => c.key === 'code')!.id;
  return { tenantId, spa, agentId: existing.id, capId };
}

describe('operator acts with a human org-plane token', () => {
  it('an owner defines a capability, creates a linked agent, and mints both kinds of token', async () => {
    await withOrgPlane(async () => {
      const { agentId, capId } = await workspace();

      const defined = await call('PATCH', `/v1/capabilities/${capId}`, await owner(), { description: 'Writes and changes code.' });
      expect(defined.status).toBe(200);
      expect(((await defined.json()) as { capability: { description: string } }).capability.description).toBe('Writes and changes code.');

      const declared = await call('POST', '/v1/capabilities', await owner(), { key: 'coordination', description: 'Plans and queues work.' });
      expect(declared.status).toBe(201);

      const created = await call('POST', '/v1/agents', await owner(), {
        name: 'Coordinator',
        capabilities: ['coordination'],
        externalId: cur.newAgent,
        concurrency: 3,
      });
      expect(created.status).toBe(201);
      const made = (await created.json()) as { agent: Record<string, unknown>; token?: string };
      expect(made.agent).toMatchObject({ name: 'Coordinator', capabilities: ['coordination'], externalId: cur.newAgent, externalSource: 'org-plane', concurrency: 3 });
      // A linked agent is minted no `spa_` on create.
      expect(made.token).toBeUndefined();

      const claimRun = await call('POST', `/v1/agents/${agentId}/tokens`, await owner(), { scopes: ['claim', 'run'] });
      expect(claimRun.status).toBe(201);
      const cr = (await claimRun.json()) as { token: string; scopes: string[] };
      expect(cr.token).toMatch(/^spa_/);
      expect(cr.scopes).toEqual(['claim', 'run']);

      const runOnly = await call('POST', `/v1/agents/${agentId}/tokens`, await owner(), { scopes: ['run'] });
      expect(runOnly.status).toBe(201);
      expect(((await runOnly.json()) as { scopes: string[] }).scopes).toEqual(['run']);
    });
  });

  it('refuses concurrency below 1 on create, and leaves no agent behind', async () => {
    await withOrgPlane(async () => {
      const { tenantId } = await workspace();
      const res = await call('POST', '/v1/agents', await owner(), { name: 'Bad', capabilities: ['code'], externalId: cur.other, concurrency: 0 });
      expect(res.status).toBe(400);
      const row = await env.DB.prepare(`SELECT 1 FROM agents WHERE tenant_id = ? AND name = 'Bad'`).bind(tenantId).first();
      expect(row).toBeNull();
    });
  });

  it('refuses a member on all three acts (403), as the cookie path does', async () => {
    await withOrgPlane(async () => {
      const { agentId, capId } = await workspace();
      const tok = await member();
      expect((await call('PATCH', `/v1/capabilities/${capId}`, tok, { description: 'x' })).status).toBe(403);
      expect((await call('POST', '/v1/capabilities', tok, { key: 'member-made' })).status).toBe(403);
      expect((await call('POST', '/v1/agents', tok, { name: 'M', capabilities: ['code'], externalId: cur.other })).status).toBe(403);
      expect((await call('POST', `/v1/agents/${agentId}/tokens`, tok, { scopes: ['run'] })).status).toBe(403);
    });
  });
});

describe('an agent is refused every operator act, whatever it holds', () => {
  for (const kind of ['spa_ token', 'agent-kind org-plane token'] as const) {
    it(`refuses a ${kind} with 403 on define, create and mint`, async () => {
      await withOrgPlane(async () => {
        const { spa, agentId, capId, tenantId } = await workspace();
        const tok = kind === 'spa_ token' ? spa : await planeAgent();

        const define = await call('PATCH', `/v1/capabilities/${capId}`, tok, { description: 'agent-written' });
        expect(define.status).toBe(403);
        expect((await call('POST', '/v1/capabilities', tok, { key: 'agent-made' })).status).toBe(403);

        const create = await call('POST', '/v1/agents', tok, { name: 'Self-made', capabilities: ['code'], externalId: cur.other });
        expect(create.status).toBe(403);
        expect(await env.DB.prepare(`SELECT 1 FROM agents WHERE tenant_id = ? AND name = 'Self-made'`).bind(tenantId).first()).toBeNull();

        const mint = await call('POST', `/v1/agents/${agentId}/tokens`, tok, { scopes: ['claim', 'run'] });
        expect(mint.status).toBe(403);
        expect(await mint.text()).not.toMatch(/spa_/);
      });
    });
  }
});

describe('a minted secret', () => {
  it('is never written to a log', async () => {
    await withOrgPlane(async () => {
      const { agentId } = await workspace();
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
      try {
        const res = await call('POST', `/v1/agents/${agentId}/tokens`, await owner(), { scopes: ['claim', 'run'] });
        const { token } = (await res.json()) as { token: string };
        expect(token).toMatch(/^spa_/);
        const logged = spies.flatMap((s) => s.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a))));
        expect(logged.filter((line) => line.includes(token))).toEqual([]);
      } finally {
        for (const s of spies) s.mockRestore();
      }
    });
  });
});

import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

/**
 * The audit's second and third still-broken findings, together, because they are the same defect
 * seen twice: an agent's properties were written exactly once and could never be changed.
 *
 * `capabilities_json` was set in the INSERT inside `createAgent` and updated nowhere, while the
 * shipped board templates need `code`, `test`, `deploy`, `triage` — so an agent could not be
 * staffed to most of the templates the product ships with, and the only remedy was to delete it
 * and make another (discarding a linked agent's principal link with it).
 *
 * Tokens had the mirror-image problem: they were only ever minted inside `POST /v1/agents`, so
 * revoking an agent's last one was terminal and a linked agent could never be issued one at all.
 */

const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

async function makeAgent(tenant: string, body: Record<string, unknown>) {
  const res = await SELF.fetch('https://api.test/v1/agents', { method: 'POST', headers: dev(tenant), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json<{ agent?: { id: string }; token?: string; tokenId?: string; error?: string }>() };
}

async function listAgents(tenant: string) {
  const res = await SELF.fetch('https://api.test/v1/agents', { headers: dev(tenant) });
  return (await res.json<{ agents: Array<Record<string, unknown>> }>()).agents;
}

async function patch(tenant: string, agentId: string, body: Record<string, unknown>) {
  return SELF.fetch(`https://api.test/v1/agents/${agentId}`, { method: 'PATCH', headers: dev(tenant), body: JSON.stringify(body) });
}

describe('an agent can be changed after it is made', () => {
  it('restaffs an agent onto the capabilities a template actually needs', async () => {
    const t = 'tnt_mut_caps';
    const { body } = await makeAgent(t, { name: 'Coder', capabilities: ['research'] });
    const id = body.agent!.id;

    expect((await patch(t, id, { capabilities: ['code', 'test', 'deploy'] })).status).toBe(200);
    const after = (await listAgents(t)).find((a) => a.id === id)!;
    expect(after.capabilities).toEqual(['code', 'test', 'deploy']);
  });

  it('normalises capabilities so they can match a stage owner slug', async () => {
    const t = 'tnt_mut_norm';
    const { body } = await makeAgent(t, { name: 'N', capabilities: [] });
    await patch(t, body.agent!.id, { capabilities: [' Code ', 'CODE', 'Test'] });
    const after = (await listAgents(t)).find((a) => a.id === body.agent!.id)!;
    expect(after.capabilities).toEqual(['code', 'test']); // trimmed, lowercased, de-duplicated
  });

  it('changes name, icon and concurrency, leaving untouched fields alone', async () => {
    const t = 'tnt_mut_fields';
    const { body } = await makeAgent(t, { name: 'Before', capabilities: ['research'] });
    const id = body.agent!.id;

    await patch(t, id, { name: 'After', iconUrl: 'https://example.test/a.png', concurrency: 4 });
    const after = (await listAgents(t)).find((a) => a.id === id)!;
    expect(after.name).toBe('After');
    expect(after.iconUrl).toBe('https://example.test/a.png');
    expect(after.concurrency).toBe(4);
    expect(after.capabilities).toEqual(['research']); // never mentioned, never blanked
  });

  it('refuses values that would silently do nothing', async () => {
    const t = 'tnt_mut_bad';
    const { body } = await makeAgent(t, { name: 'B', capabilities: [] });
    const id = body.agent!.id;

    expect((await patch(t, id, { name: '   ' })).status).toBe(400);
    expect((await patch(t, id, { capabilities: ['ok', ''] })).status).toBe(400);
    expect((await patch(t, id, { iconUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await patch(t, id, { concurrency: 0 })).status).toBe(400);
    expect((await patch(t, id, {})).status).toBe(400); // named nothing at all
  });

  it('still links a principal, and can link and restaff in one request', async () => {
    const t = 'tnt_mut_link';
    const { body } = await makeAgent(t, { name: 'L', capabilities: [] });
    const id = body.agent!.id;

    const res = await patch(t, id, { capabilities: ['triage'], externalId: 'prn_0123456789abcdef0123' });
    expect(res.status).toBe(200);
    const after = (await listAgents(t)).find((a) => a.id === id)!;
    expect(after.capabilities).toEqual(['triage']);
    expect(after.externalId).toBe('prn_0123456789abcdef0123');
  });

  it('does not reach into another tenant', async () => {
    const { body } = await makeAgent('tnt_mut_owner', { name: 'Mine', capabilities: ['research'] });
    const res = await patch('tnt_mut_intruder', body.agent!.id, { capabilities: ['stolen'] });
    expect(res.status).toBe(404);
    const after = (await listAgents('tnt_mut_owner')).find((a) => a.id === body.agent!.id)!;
    expect(after.capabilities).toEqual(['research']);
  });
});

describe('a revoked agent can be given a new token', () => {
  it('issues a fresh token that authenticates, after the only one was revoked', async () => {
    const t = 'tnt_remint';
    const { body } = await makeAgent(t, { name: 'R', capabilities: ['research'] });
    const id = body.agent!.id;

    const revoked = await SELF.fetch(`https://api.test/v1/agents/${id}/tokens/${body.tokenId}`, { method: 'DELETE', headers: dev(t) });
    expect(revoked.status).toBe(204);
    expect((await listAgents(t)).find((a) => a.id === id)!.tokenIds).toEqual([]);

    const minted = await SELF.fetch(`https://api.test/v1/agents/${id}/tokens`, { method: 'POST', headers: dev(t) });
    expect(minted.status).toBe(201);
    const fresh = await minted.json<{ token: string; tokenId: string }>();
    expect(fresh.token).toMatch(/^kbn_/);

    // The proof that it is a credential and not just a string: it authenticates a real claim.
    const boardRes = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'B', stages: [{ key: 'research', name: 'R', order: 0, ownerKind: 'capability', owner: 'research' }] }),
    });
    const { boardId } = await boardRes.json<{ boardId: string }>();
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: dev(t), body: JSON.stringify({ title: 'x' }) });
    const claim = await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fresh.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect((await claim.json<{ claimed: boolean }>()).claimed).toBe(true);
  });

  it('issues a token for a linked agent, which is created with none', async () => {
    const t = 'tnt_remint_linked';
    const { body } = await makeAgent(t, { name: 'Linked', externalId: 'prn_abcdefabcdefabcdefab' });
    expect(body.token).toBeUndefined(); // a linked agent gets no kbn_ at creation

    const minted = await SELF.fetch(`https://api.test/v1/agents/${body.agent!.id}/tokens`, { method: 'POST', headers: dev(t) });
    expect(minted.status).toBe(201);
    expect((await minted.json<{ token: string }>()).token).toMatch(/^kbn_/);
  });

  it('refuses to mint for an agent in another tenant', async () => {
    const { body } = await makeAgent('tnt_remint_a', { name: 'A', capabilities: [] });
    const res = await SELF.fetch(`https://api.test/v1/agents/${body.agent!.id}/tokens`, { method: 'POST', headers: dev('tnt_remint_b') });
    expect(res.status).toBe(404);
  });
});

describe('token scopes are compared to the action attempted', () => {
  /** Mint a token by hand with an arbitrary scope set — the route only ever mints the default. */
  async function tokenWithScopes(tenant: string, agentId: string, scopes: string[]): Promise<string> {
    const { generateAgentToken, hashToken } = await import('../src/auth/agent-token');
    const token = generateAgentToken();
    await env.DB.prepare(`INSERT INTO agent_tokens (id, tenant_id, agent_id, token_hash, scopes_json) VALUES (?, ?, ?, ?, ?)`)
      .bind(`tok_${Math.random().toString(16).slice(2, 12)}`, tenant, agentId, await hashToken(token), JSON.stringify(scopes))
      .run();
    return token;
  }

  async function boardWithCard(tenant: string): Promise<string> {
    const res = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: dev(tenant),
      body: JSON.stringify({ name: 'S', stages: [{ key: 'research', name: 'R', order: 0, ownerKind: 'capability', owner: 'research' }] }),
    });
    const { boardId } = await res.json<{ boardId: string }>();
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: dev(tenant), body: JSON.stringify({ title: 'x' }) });
    return boardId;
  }

  it('refuses a claim from a token that may only run', async () => {
    const t = 'tnt_scope_run';
    const { body } = await makeAgent(t, { name: 'S', capabilities: ['research'] });
    const token = await tokenWithScopes(t, body.agent!.id, ['run']);
    const boardId = await boardWithCard(t);

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toContain('claim');
  });

  it('lets a legacy claim-only token finish the work it took — the grandfather clause', async () => {
    const t = 'tnt_scope_legacy';
    const { body } = await makeAgent(t, { name: 'L', capabilities: ['research'] });
    const token = await tokenWithScopes(t, body.agent!.id, ['claim']);
    const boardId = await boardWithCard(t);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const claim = await (await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, { method: 'POST', headers: auth, body: '{}' })).json<{
      claimed: boolean;
      runId?: string;
      leaseEpoch?: number;
    }>();
    expect(claim.claimed).toBe(true);

    // A claim an agent cannot finish is worse than no check at all: the card would be taken and
    // abandoned mid-flight. So `claim` implies `run` for tokens minted before the split existed.
    const beat = await SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${claim.runId}/heartbeat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ leaseEpoch: claim.leaseEpoch }),
    });
    expect(beat.status).toBe(200);
  });

  it('mints both scopes on every new token, so the grandfather clause ages out', async () => {
    const t = 'tnt_scope_new';
    const { body } = await makeAgent(t, { name: 'N', capabilities: [] });
    const row = await env.DB.prepare(`SELECT scopes_json FROM agent_tokens WHERE agent_id = ?`).bind(body.agent!.id).first<{ scopes_json: string }>();
    expect(JSON.parse(row!.scopes_json)).toEqual(['claim', 'run']);
  });
});

/**
 * REST route for linking an agent to a suite principal (slice C, task 4).
 *
 * `setAgentExternalMapping` (catalog.ts) has existed since an earlier task with no caller —
 * `test/agent-external-mapping.test.ts` proves the write in isolation. This is that caller:
 * `PATCH /v1/agents/:id { externalId }`. What matters is not that the column gets written again
 * here — it's that a mapping set THROUGH THIS ROUTE is what lets `resolveHubAgent` turn an
 * agent-kind hub token into a local agent, which is the whole reason the mapping exists.
 *
 * Same posture as `test/agent-token-revocation.test.ts`: linking is a HUMAN act. An agent's own
 * `kbn_` bearer must not be able to link itself (or anything else) to a principal, and one
 * tenant's session must not be able to link another tenant's agent.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resolveHubAgent } from '../src/auth/resolve';

const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

const ISSUER = 'https://issuer.test';
const FLEET = 'fleet_00000000000000aprnrt';

/** A syntactically valid `prn_` + 20 lowercase-hex principal id, distinct per call. */
function prn(n: number): string {
  return `prn_${n.toString(16).padStart(20, '0')}`;
}

async function newIssuer() {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  const jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'aprt-kid' }] });
  return { signingKey: pair.privateKey, jwksBody };
}

async function withIssuer(jwksBody: string, fn: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  (env as unknown as Record<string, unknown>).HUB_ISSUER = ISSUER;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === `${ISSUER}/api/auth/jwks`) return new Response(jwksBody, { headers: { 'content-type': 'application/json' } });
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
  }
}

async function mapTenant(fleet: string, tenantId: string): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'T')`).bind(tenantId, `slug-${tenantId}`).run();
  await env.DB.prepare(`UPDATE tenants SET external_source = 'agentpod', external_id = ? WHERE id = ?`).bind(fleet, tenantId).run();
}

async function createAgentViaRest(tenant: string, name: string): Promise<{ id: string; token: string }> {
  const res = await SELF.fetch('https://api.test/v1/agents', {
    method: 'POST',
    headers: dev(tenant),
    body: JSON.stringify({ name, capabilities: ['research'] }),
  });
  const body = await res.json<{ agent: { id: string }; token: string }>();
  return { id: body.agent.id, token: body.token };
}

describe('PATCH /v1/agents/:id — link a suite principal', () => {
  it('a mapping set through the route is what makes resolveHubAgent resolve that agent', async () => {
    const agent = await createAgentViaRest('tnt_prt_link', 'Linkable');
    const sub = prn(1);

    const patch = await SELF.fetch(`https://api.test/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: dev('tnt_prt_link'),
      body: JSON.stringify({ externalId: sub }),
    });
    expect(patch.status).toBe(200);

    const { signingKey, jwksBody } = await newIssuer();
    await mapTenant(FLEET, 'tnt_prt_link');

    await withIssuer(jwksBody, async () => {
      const token = await new SignJWT({ tenant: FLEET, sub, principalKind: 'agent' })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'aprt-kid' })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(ISSUER)
        .setExpirationTime('5m')
        .sign(signingKey);
      const req = new Request('https://api.test/v1/boards/brd_x/claims', { headers: { Authorization: `Bearer ${token}` } });
      const resolved = await resolveHubAgent(req, env);
      expect(resolved).not.toBeNull();
      expect(resolved!.agentId).toBe(agent.id);
      expect(resolved!.tenantId).toBe('tnt_prt_link');
    });
  });

  it('before linking, the same hub token resolves nothing — the route is what changes that', async () => {
    const agent = await createAgentViaRest('tnt_prt_before', 'Unlinked');
    const sub = prn(2);
    const { signingKey, jwksBody } = await newIssuer();
    await mapTenant(FLEET, 'tnt_prt_before');

    await withIssuer(jwksBody, async () => {
      const token = await new SignJWT({ tenant: FLEET, sub, principalKind: 'agent' })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'aprt-kid' })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(ISSUER)
        .setExpirationTime('5m')
        .sign(signingKey);
      const req = new Request('https://api.test/v1/boards/brd_x/claims', { headers: { Authorization: `Bearer ${token}` } });
      expect(await resolveHubAgent(req, env)).toBeNull();
    });
    void agent;
  });

  it('rejects a malformed principal id before it is ever written', async () => {
    const agent = await createAgentViaRest('tnt_prt_bad', 'Typo target');

    const bad = await SELF.fetch(`https://api.test/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: dev('tnt_prt_bad'),
      body: JSON.stringify({ externalId: 'not-a-principal' }),
    });
    expect(bad.status).toBe(400);
    const body = await bad.json<{ error: string }>();
    expect(body.error).toMatch(/prn_/);

    const list = await (await SELF.fetch('https://api.test/v1/agents', { headers: dev('tnt_prt_bad') })).json<{
      agents: Array<{ id: string; externalId: string | null }>;
    }>();
    expect(list.agents.find((a) => a.id === agent.id)?.externalId).toBeNull();
  });

  it('clears a mapping with externalId: null', async () => {
    const agent = await createAgentViaRest('tnt_prt_clear', 'Clearable');
    const sub = prn(3);
    await SELF.fetch(`https://api.test/v1/agents/${agent.id}`, { method: 'PATCH', headers: dev('tnt_prt_clear'), body: JSON.stringify({ externalId: sub }) });

    const clear = await SELF.fetch(`https://api.test/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: dev('tnt_prt_clear'),
      body: JSON.stringify({ externalId: null }),
    });
    expect(clear.status).toBe(200);

    const list = await (await SELF.fetch('https://api.test/v1/agents', { headers: dev('tnt_prt_clear') })).json<{
      agents: Array<{ id: string; externalId: string | null }>;
    }>();
    expect(list.agents.find((a) => a.id === agent.id)?.externalId).toBeNull();
  });

  it('is a human act — an agent bearer token, or no credential at all, cannot link a principal', async () => {
    const agent = await createAgentViaRest('tnt_prt_human', 'Bot');

    const noAuth = await SELF.fetch(`https://api.test/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalId: prn(4) }),
    });
    expect(noAuth.status).toBe(401);

    const viaAgentToken = await SELF.fetch(`https://api.test/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalId: prn(5) }),
    });
    expect(viaAgentToken.status).toBe(401);

    // Neither attempt actually wrote a mapping.
    const list = await (await SELF.fetch('https://api.test/v1/agents', { headers: dev('tnt_prt_human') })).json<{
      agents: Array<{ id: string; externalId: string | null }>;
    }>();
    expect(list.agents.find((a) => a.id === agent.id)?.externalId).toBeNull();
  });

  it('refuses to link an agent that belongs to a different tenant', async () => {
    const owned = await createAgentViaRest('tnt_prt_owner', 'Owned');

    const res = await SELF.fetch(`https://api.test/v1/agents/${owned.id}`, {
      method: 'PATCH',
      headers: dev('tnt_prt_intruder'),
      body: JSON.stringify({ externalId: prn(6) }),
    });
    expect(res.status).toBe(404);

    const list = await (await SELF.fetch('https://api.test/v1/agents', { headers: dev('tnt_prt_owner') })).json<{
      agents: Array<{ id: string; externalId: string | null }>;
    }>();
    expect(list.agents.find((a) => a.id === owned.id)?.externalId).toBeNull();
  });

  // --- Finding B: one principal, one agent -----------------------------------------------------

  it('refuses a second agent claiming a principal already linked to a different agent, with 409', async () => {
    const first = await createAgentViaRest('tnt_prt_claim', 'First claimant');
    const second = await createAgentViaRest('tnt_prt_claim', 'Second claimant');
    const sub = prn(7);

    const linkFirst = await SELF.fetch(`https://api.test/v1/agents/${first.id}`, {
      method: 'PATCH',
      headers: dev('tnt_prt_claim'),
      body: JSON.stringify({ externalId: sub }),
    });
    expect(linkFirst.status).toBe(200);

    const linkSecond = await SELF.fetch(`https://api.test/v1/agents/${second.id}`, {
      method: 'PATCH',
      headers: dev('tnt_prt_claim'),
      body: JSON.stringify({ externalId: sub }),
    });
    expect(linkSecond.status).toBe(409);
    const body = await linkSecond.json<{ error: string }>();
    expect(body.error).toMatch(new RegExp(sub));

    // The second attempt changed nothing: the principal is still the first agent's alone.
    const list = await (await SELF.fetch('https://api.test/v1/agents', { headers: dev('tnt_prt_claim') })).json<{
      agents: Array<{ id: string; externalId: string | null }>;
    }>();
    expect(list.agents.find((a) => a.id === first.id)?.externalId).toBe(sub);
    expect(list.agents.find((a) => a.id === second.id)?.externalId).toBeNull();
  });

  it('re-linking an agent to the principal it already has stays idempotent, not a 409', async () => {
    const agent = await createAgentViaRest('tnt_prt_relink', 'Relinkable');
    const sub = prn(8);

    const first = await SELF.fetch(`https://api.test/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: dev('tnt_prt_relink'),
      body: JSON.stringify({ externalId: sub }),
    });
    expect(first.status).toBe(200);

    const again = await SELF.fetch(`https://api.test/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: dev('tnt_prt_relink'),
      body: JSON.stringify({ externalId: sub }),
    });
    expect(again.status).toBe(200);

    const list = await (await SELF.fetch('https://api.test/v1/agents', { headers: dev('tnt_prt_relink') })).json<{
      agents: Array<{ id: string; externalId: string | null }>;
    }>();
    expect(list.agents.find((a) => a.id === agent.id)?.externalId).toBe(sub);
  });
});

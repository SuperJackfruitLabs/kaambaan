import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { setupCatalog } from './helpers/catalog';
import { withOrgPlane, planeToken, planeEnv, ORG, OTHER_ORG, HUMAN, AGENT, SERVICE } from './helpers/org-plane';
import { withIssuer } from './helpers/hub-issuer';
import { resolveHubAgent, resolveHubService, resolveHubUser } from '../src/auth/resolve';
import { createAgent, setAgentExternalMapping, findTenantByExternal } from '../src/db/catalog';
import { ensureOrgTenant } from '../src/auth/org-tenancy';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';

beforeAll(setupCatalog);

const get = (path: string, token: string) =>
  SELF.fetch(`https://api.test${path}`, { headers: { Authorization: `Bearer ${token}` } });

/** A hub token, as production issues today, for the no-dual-accept and rollback checks. */
const HUB = 'https://hub.test';
async function hubFixture() {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  const jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'hub-kid' }] });
  const token = await new SignJWT({ sub: 'hubsub_rest', principalKind: 'human', tenant: 'fleet_0000000000000000rest' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'hub-kid' })
    .setIssuer(HUB).setAudience([HUB, 'https://api.test']).setIssuedAt().setExpirationTime('5m')
    .sign(pair.privateKey);
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name, external_source, external_id) VALUES ('tnt_hubrest', 'hubrest', 'H', 'agentpod', 'fleet_0000000000000000rest')`).run();
  return { token, jwksBody };
}

describe('plane mode — a human bearer', () => {
  it('lands in the org tenant, created on first sight, as its first owner', async () => {
    await withOrgPlane(async () => {
      const res = await get('/v1/boards', await planeToken());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ boards: [] });
      const tenant = await findTenantByExternal(env.DB, 'org-plane', ORG);
      expect(tenant).toMatch(/^tnt_/);
      const u = await resolveHubUser(new Request('https://api.test/v1/boards', { headers: { Authorization: `Bearer ${await planeToken()}` } }), planeEnv());
      expect(u).toMatchObject({ tenantId: tenant, role: 'owner', mayDispatch: [] });
    });
  });

  it('carries mayDispatch from the token, never from a stored copy', async () => {
    await withOrgPlane(async () => {
      const req = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken({ mayDispatch: [AGENT] })}` } });
      expect((await resolveHubUser(req, planeEnv()))?.mayDispatch).toEqual([AGENT]);
    });
  });

  it('answers 403 product_not_enabled — with the org — when ent lacks superpipeline', async () => {
    await withOrgPlane(async () => {
      const res = await get('/v1/boards', await planeToken({ org: OTHER_ORG, ent: ['agentpod'] }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'product_not_enabled', org: OTHER_ORG });
      // …and first sight did not run for an org that is not entitled.
      expect(await findTenantByExternal(env.DB, 'org-plane', OTHER_ORG)).toBeNull();
    });
  });

  it('refuses a token for the MCP audience on REST (401, not 403)', async () => {
    await withOrgPlane(async () => {
      expect((await get('/v1/boards', await planeToken({}, { aud: 'https://api.test/mcp' }))).status).toBe(401);
    });
  });

  it('refuses a token signed by a stranger', async () => {
    await withOrgPlane(async () => {
      const stranger = (await generateKeyPair('EdDSA')).privateKey;
      expect((await get('/v1/boards', await planeToken({}, { kid: 'nope', key: stranger }))).status).toBe(401);
    });
  });
});

describe('no dual-accept, and rollback', () => {
  it('refuses a valid HUB token while plane mode is on, and accepts it again once plane mode is off', async () => {
    const { token, jwksBody } = await hubFixture();
    await withIssuer(HUB, jwksBody, async () => {
      __resetJwksCacheForTests();
      expect((await get('/v1/boards', token)).status, 'hub mode accepts the hub token').toBe(200);
      await withOrgPlane(async () => {
        expect((await get('/v1/boards', token)).status, 'plane mode refuses it').toBe(401);
      });
      __resetJwksCacheForTests();
      expect((await get('/v1/boards', token)).status, 'rollback accepts it again').toBe(200);
    });
  });

  it('refuses a plane token while plane mode is off', async () => {
    expect((await get('/v1/boards', await planeToken())).status).toBe(401);
  });

  it('fails closed — plane AND hub refused — when ORG_PLANE_ISSUER is set but the rest is missing', async () => {
    const { token, jwksBody } = await hubFixture();
    // The hub's key set IS answerable here, so a refusal can only come from the half-set switch.
    await withIssuer(HUB, jwksBody, async () => {
      __resetJwksCacheForTests();
      const hubReq = () => new Request('https://api.test/v1/boards', { headers: { Authorization: `Bearer ${token}` } });
      expect(await resolveHubUser(hubReq(), planeEnv({ ORG_PLANE_ISSUER: undefined })), 'control: hub mode accepts it').not.toBeNull();
      const half = planeEnv({ ORG_PLANE_JWKS_URL: undefined });
      const planeReq = new Request('https://api.test/v1/boards', { headers: { Authorization: `Bearer ${await planeToken()}` } });
      expect(await resolveHubUser(hubReq(), half)).toBeNull();
      expect(await resolveHubUser(planeReq, half)).toBeNull();
    });
  });
});

describe('plane mode — agent and service bearers', () => {
  it('resolves an agent token to the local agent mapped by its prn_, in the org tenant', async () => {
    await withOrgPlane(async () => {
      const tenantId = await ensureOrgTenant(env.DB, ORG);
      const agent = await createAgent(env.DB, tenantId, { name: 'Researcher', capabilities: ['research'] });
      await setAgentExternalMapping(env.DB, tenantId, agent.id, { externalSource: 'org-plane', externalId: AGENT });
      const req = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken({ sub: AGENT, principalKind: 'agent', mayDispatch: [] })}` } });
      const resolved = await resolveHubAgent(req, planeEnv());
      expect(resolved).toMatchObject({ tenantId, agentId: agent.id, capabilities: ['research'], externalId: AGENT, mayDispatch: [] });
      // No `scope` claim → no grant scopes ([]), never unscoped (null/undefined).
      expect(resolved?.scopes).toEqual([]);
      const scoped = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken({ sub: AGENT, principalKind: 'agent', scope: 'claim run' })}` } });
      expect((await resolveHubAgent(scoped, planeEnv()))?.scopes).toEqual(['claim', 'run']);
    });
  });

  it('refuses an agent token whose org is not the tenant its row sits in', async () => {
    await withOrgPlane(async () => {
      // Both orgs have tenants here, so only the row-vs-claim comparison can refuse.
      const tenantId = await ensureOrgTenant(env.DB, ORG);
      await ensureOrgTenant(env.DB, OTHER_ORG);
      const other = 'prn_000000000000000000a5';
      const agent = await createAgent(env.DB, tenantId, { name: 'Elsewhere', capabilities: [] });
      await setAgentExternalMapping(env.DB, tenantId, agent.id, { externalSource: 'org-plane', externalId: other });
      const token = (org: string) => planeToken({ sub: other, principalKind: 'agent', org });
      const req = async (org: string) => new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await token(org)}` } });
      expect(await resolveHubAgent(await req(ORG), planeEnv()), 'control: its own org resolves').not.toBeNull();
      expect(await resolveHubAgent(await req(OTHER_ORG), planeEnv())).toBeNull();
    });
  });

  it('never lets a human token act as an agent, or the reverse', async () => {
    await withOrgPlane(async () => {
      const human = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken()}` } });
      const agent = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken({ sub: AGENT, principalKind: 'agent' })}` } });
      expect(await resolveHubAgent(human, planeEnv())).toBeNull();
      expect(await resolveHubUser(agent, planeEnv())).toBeNull();
    });
  });

  it('resolves a service token with its grant scopes', async () => {
    await withOrgPlane(async () => {
      const tenantId = await ensureOrgTenant(env.DB, ORG);
      const req = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken({ sub: SERVICE, principalKind: 'service', scope: 'evidence:read', email: undefined, email_verified: undefined })}` } });
      expect(await resolveHubService(req, planeEnv())).toEqual({ principalId: SERVICE, tenantId, scopes: ['evidence:read'] });
    });
  });
});

describe('plane mode — the fleet link cannot overwrite the org mapping', () => {
  it('PATCH /v1/tenant answers 409 in plane mode', async () => {
    await withOrgPlane(async () => {
      const res = await SELF.fetch('https://api.test/v1/tenant', {
        method: 'PATCH',
        headers: { 'X-Tenant-Id': 'tnt_patch', 'X-User-Id': 'usr_p', 'Content-Type': 'application/json' },
        body: JSON.stringify({ externalId: 'fleet_0123456789abcdef0123' }),
      });
      expect(res.status).toBe(409);
    });
  });
});

describe('evidence ids for re-pointed users', () => {
  it('principalIdsFor maps a usr_ mapped to org-plane to its prn_', async () => {
    const { principalIdsFor, upsertUserByEmail, setUserExternalMapping } = await import('../src/db/catalog');
    const u = await upsertUserByEmail(env.DB, { email: 'evidence@example.com', name: null });
    await setUserExternalMapping(env.DB, u.id, { externalSource: 'org-plane', externalId: HUMAN.replace('a1', 'e1') });
    expect((await principalIdsFor(env.DB, 'tnt_any', [u.id])).get(u.id)).toBe(HUMAN.replace('a1', 'e1'));
  });
});

/**
 * REST route for linking a workspace to a hub fleet — the whole-branch review's Important.
 *
 * `setTenantExternalMapping` (catalog.ts) had NO production caller, only tests: the fifth column
 * in this programme with none. That would be a curiosity except that BOTH `resolveHubUser` and
 * `resolveHubAgent` require `findTenantByExternal(db, 'agentpod', claims.tenant)` to resolve
 * before a hub-issued credential can do anything in kaambaan — so the row existed only where
 * somebody had made it by hand, which is the suite's "no SQL at any point" rule broken at the
 * exact seam between the two repositories.
 *
 * `PATCH /v1/tenant` is that writer, and this file is careful about what it proves. **Nothing
 * below writes `tenants.external_id` by hand.** The point is not that the column can be set —
 * `test/tenant-external-mapping.test.ts` proves the write in isolation — it is that a mapping set
 * THROUGH THIS ROUTE is what makes a hub credential resolve, which is the only reason the column
 * exists. Every other test in this repo that needs a linked tenant does it with raw SQL; that is
 * precisely the hand-made row this route replaces.
 *
 * Same posture as `agent-principal-rest.test.ts`: linking is a HUMAN act. And here it can only
 * be one — `resolveHubUser` needs this mapping to already exist, so a hub token could never
 * establish the mapping that makes that token resolve.
 *
 * **What this file deliberately does NOT assert.** The mapping is many-to-one by migration
 * 0002's explicit decision, and `findTenantByExternal` resolves it with an unordered `.first()`
 * — so a hub credential for a SHARED fleet lands in an arbitrary one of the sharing workspaces.
 * That is a real ambiguity, it predates this route, and settling it means deciding whether
 * hub-token resolution is well-defined under a many-to-one mapping at all. Recorded, not
 * papered over with a uniqueness the schema was written to refuse.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resolveHubUser, resolveHubAgent } from '../src/auth/resolve';

const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

const ISSUER = 'https://issuer.test';

/** A syntactically valid `fleet_` + 20 lowercase-hex id, distinct per call. */
function fleet(n: number): string {
  return `fleet_${n.toString(16).padStart(20, '0')}`;
}
function prn(n: number): string {
  return `prn_${n.toString(16).padStart(20, '0')}`;
}

/**
 * ONE issuer for the whole file, minted once.
 *
 * `hub-jwt.ts` caches a JWKS per issuer for ten minutes and refetches only on an UNKNOWN kid, so
 * a fresh key pair per test under a reused kid verifies against the first test's cached key and
 * fails — a property of the cache working correctly, not a bug, but a trap worth naming here.
 */
let issuerOnce: Promise<{ signingKey: CryptoKey; jwksBody: string }> | null = null;
function newIssuer() {
  issuerOnce ??= (async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    const jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'tlr-kid' }] });
    return { signingKey: pair.privateKey, jwksBody };
  })();
  return issuerOnce;
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

/** The workspace row itself — NOT its mapping, which only the route ever writes here. */
async function workspace(tenantId: string): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'T')`).bind(tenantId, `slug-${tenantId}`).run();
}

function link(tenantId: string, externalId: string | null) {
  return SELF.fetch('https://api.test/v1/tenant', {
    method: 'PATCH',
    headers: dev(tenantId),
    body: JSON.stringify({ externalId }),
  });
}

async function hubToken(signingKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'tlr-kid' })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}

describe('PATCH /v1/tenant — link this workspace to a hub fleet', () => {
  it('a mapping set through the route is what makes a hub-issued human token resolve', async () => {
    const tenantId = 'tnt_tlr_human';
    const FLEET = fleet(0x11);
    await workspace(tenantId);
    const { signingKey, jwksBody } = await newIssuer();

    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, { sub: 'prn_human', tenant: FLEET, principalKind: 'human' });
      const req = () => new Request('https://api.test/v1/boards', { headers: { Authorization: `Bearer ${token}` } });

      // Before the link: the token verifies, and resolves to nobody. That is the whole
      // consequence of the missing writer — a fleet nobody linked is invisible, silently.
      expect(await resolveHubUser(req(), env), 'unlinked, so the fleet is invisible').toBeNull();

      const res = await link(tenantId, FLEET);
      expect(res.status).toBe(200);

      const resolved = await resolveHubUser(req(), env);
      expect(resolved, 'linked through the route, and now it resolves').not.toBeNull();
      expect(resolved!.tenantId).toBe(tenantId);
    });
  });

  it('and it is what makes an agent-kind hub token resolve too — both resolvers go through this row', async () => {
    const tenantId = 'tnt_tlr_agent';
    const FLEET = fleet(0x12);
    const SUB = prn(0x12);
    await workspace(tenantId);

    // The agent half is linked through ITS route, the same way — no SQL on either side.
    const created = await SELF.fetch('https://api.test/v1/agents', {
      method: 'POST',
      headers: dev(tenantId),
      body: JSON.stringify({ name: 'Linked', capabilities: ['research'] }),
    });
    const agentId = (await created.json<{ agent: { id: string } }>()).agent.id;
    const patched = await SELF.fetch(`https://api.test/v1/agents/${agentId}`, {
      method: 'PATCH',
      headers: dev(tenantId),
      body: JSON.stringify({ externalId: SUB }),
    });
    expect(patched.status).toBe(200);

    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, { sub: SUB, tenant: FLEET, principalKind: 'agent' });
      const req = () => new Request('https://api.test/v1/boards/b/cards', { headers: { Authorization: `Bearer ${token}` } });

      // The agent IS mapped. It still resolves to nothing, because the tenant is not — which is
      // the cross-repo half of the spec, gated on this one row.
      expect(await resolveHubAgent(req(), env), 'agent mapped, fleet not: still nobody').toBeNull();

      expect((await link(tenantId, FLEET)).status).toBe(200);

      const resolved = await resolveHubAgent(req(), env);
      expect(resolved, 'and with the fleet linked, the agent resolves').not.toBeNull();
      expect(resolved!.agentId).toBe(agentId);
      expect(resolved!.tenantId).toBe(tenantId);
    });
  });

  it('unlinking with null makes the fleet invisible again — a link is reversible without SQL', async () => {
    const tenantId = 'tnt_tlr_unlink';
    const FLEET = fleet(0x13);
    await workspace(tenantId);
    const { signingKey, jwksBody } = await newIssuer();

    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, { sub: 'prn_h2', tenant: FLEET, principalKind: 'human' });
      const req = () => new Request('https://api.test/v1/boards', { headers: { Authorization: `Bearer ${token}` } });

      expect((await link(tenantId, FLEET)).status).toBe(200);
      expect(await resolveHubUser(req(), env)).not.toBeNull();

      expect((await link(tenantId, null)).status).toBe(200);
      expect(await resolveHubUser(req(), env), 'unlinked: the credential stops resolving').toBeNull();
    });
  });

  it('two workspaces may share one fleet — the route does not invent a uniqueness the schema refused', async () => {
    // The obvious mirror of `PATCH /v1/agents/:id` would 409 here, and this route was first
    // written that way, with a partial unique index behind it. Migration 0002's own comment
    // settles it the other way: "Deliberately NOT unique. kaambaan is one-tenant-per-user, so
    // two people in the same real organisation legitimately map two local boundaries onto one
    // external id." `test/tenant-external-mapping.test.ts` asserts that directly. A fix wave is
    // not the place to reverse a documented decision, so this pins the behaviour that survived.
    const FLEET = fleet(0x14);
    await workspace('tnt_tlr_first');
    await workspace('tnt_tlr_second');

    expect((await link('tnt_tlr_first', FLEET)).status).toBe(200);
    expect((await link('tnt_tlr_second', FLEET)).status, 'a shared mapping is legitimate').toBe(200);

    // A shared mapping is never a shared keyspace — isolation stays local, on tenant_id.
    const rows = await env.DB.prepare(
      `SELECT id FROM tenants WHERE external_source = 'agentpod' AND external_id = ? ORDER BY id`,
    ).bind(FLEET).all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual(['tnt_tlr_first', 'tnt_tlr_second']);
  });

  it('a mangled fleet id is a 400 that names the mistake, not a mapping that matches nothing', async () => {
    await workspace('tnt_tlr_bad');
    const res = await link('tnt_tlr_bad', 'FLEET_00000000000000000000');
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain('fleet_');

    const row = await env.DB.prepare(`SELECT external_id AS e FROM tenants WHERE id = 'tnt_tlr_bad'`).first<{ e: string | null }>();
    expect(row!.e, 'and nothing was written').toBeNull();
  });

  it('a missing externalId is a 400 — omitting the field is not the same act as sending null', async () => {
    await workspace('tnt_tlr_omit');
    const res = await SELF.fetch('https://api.test/v1/tenant', { method: 'PATCH', headers: dev('tnt_tlr_omit'), body: '{}' });
    expect(res.status).toBe(400);
  });

  it('linking is a human act: an agent\'s own kbn_ bearer cannot do it', async () => {
    const tenantId = 'tnt_tlr_agentcred';
    await workspace(tenantId);
    const created = await SELF.fetch('https://api.test/v1/agents', {
      method: 'POST',
      headers: dev(tenantId),
      body: JSON.stringify({ name: 'Ambitious', capabilities: [] }),
    });
    const token = (await created.json<{ token: string }>()).token;

    const res = await SELF.fetch('https://api.test/v1/tenant', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalId: fleet(0x16) }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /v1/tenant shows an operator whether this workspace is linked, and to what', async () => {
    const tenantId = 'tnt_tlr_get';
    const FLEET = fleet(0x17);
    await workspace(tenantId);

    const before = await SELF.fetch('https://api.test/v1/tenant', { headers: dev(tenantId) });
    expect(before.status).toBe(200);
    expect((await before.json<{ tenant: { externalId: string | null } }>()).tenant.externalId).toBeNull();

    await link(tenantId, FLEET);
    const after = await SELF.fetch('https://api.test/v1/tenant', { headers: dev(tenantId) });
    const body = await after.json<{ tenant: { externalId: string; externalSource: string } }>();
    expect(body.tenant.externalId).toBe(FLEET);
    expect(body.tenant.externalSource, 'the source is the route\'s, never the caller\'s').toBe('agentpod');
  });
});

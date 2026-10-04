/**
 * Resolving a SERVICE-kind hub token (superwitness). Mirrors hub-token-agent.test.ts: the same
 * refusals, the same tenant mapping, and scopes read from the claim, never inferred.
 */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { setupCatalog } from './helpers/catalog';
import { resolveHubService } from '../src/auth/resolve';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';

const ISSUER = 'https://issuer-svc.test';
const PLANE = 'https://api.test';
const FLEET = 'fleet_000000000000000000sv';
const TENANT = 'tnt_svc_map';
let signingKey: CryptoKey;
let jwksBody: string;

beforeAll(async () => {
  await setupCatalog();
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'svc-kid' }] });
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'S')`).bind(TENANT, `slug-${TENANT}`).run();
  await env.DB.prepare(`UPDATE tenants SET external_source='agentpod', external_id=? WHERE id=?`).bind(FLEET, TENANT).run();
});

async function withIssuer<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  (env as unknown as Record<string, unknown>).HUB_ISSUER = ISSUER;
  __resetJwksCacheForTests();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === `${ISSUER}/api/auth/jwks`
      ? new Response(jwksBody, { headers: { 'content-type': 'application/json' } })
      : realFetch(input as RequestInfo, init)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
  }
}

const token = (over: Record<string, unknown>) =>
  new SignJWT({ sub: 'prn_0123456789abcdef0123', principalKind: 'service', tenant: FLEET, mayDispatch: [], mayGrantReach: false, ...over })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'svc-kid' })
    .setIssuedAt().setIssuer(ISSUER).setAudience([ISSUER, PLANE]).setExpirationTime('5m')
    .sign(signingKey);
const req = (t: string) => new Request('https://api.test/v1/boards/brd_x/runs/run_x/evidence', { headers: { Authorization: `Bearer ${t}` } });

describe('resolveHubService', () => {
  it('resolves a service token to its mapped tenant and its scopes', async () => {
    const svc = await withIssuer(async () => resolveHubService(req(await token({ scope: 'evidence:read other:thing' })), env));
    expect(svc).toEqual({ principalId: 'prn_0123456789abcdef0123', tenantId: TENANT, scopes: ['evidence:read', 'other:thing'] });
  });

  it('a token with no scope claim holds no scopes', async () => {
    const svc = await withIssuer(async () => resolveHubService(req(await token({})), env));
    expect(svc?.scopes).toEqual([]);
  });

  it('a human or agent token is not a service, whatever it carries', async () => {
    for (const kind of ['human', 'agent']) {
      expect(await withIssuer(async () => resolveHubService(req(await token({ principalKind: kind, scope: 'evidence:read' })), env))).toBeNull();
    }
  });

  it('an unmapped fleet is refused', async () => {
    expect(await withIssuer(async () => resolveHubService(req(await token({ tenant: 'fleet_ffffffffffffffffffff', scope: 'evidence:read' })), env))).toBeNull();
  });
});

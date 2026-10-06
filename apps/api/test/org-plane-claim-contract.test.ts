import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import fixture from './fixtures/org-plane-token-claims.json';
import { verifyOrgPlaneToken, type OrgPlaneConfig } from '../src/auth/org-plane';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';
import { PLANE, PLANE_JWKS, APP_AUD, MCP_AUD, KID, planeKeys } from './helpers/org-plane';

/** Bump only after diffing against the plane's own fixture and fixing the consumer first. */
const FIXTURE_VERSION = 1;
const CFG: OrgPlaneConfig = { issuer: PLANE, jwksUrl: PLANE_JWKS, audience: APP_AUD, mcpAudience: MCP_AUD, url: PLANE };
const fetchImpl = (async () =>
  new Response((await planeKeys()).jwksBody, { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

async function sign(payload: Record<string, unknown>, drop?: string): Promise<string> {
  const { privateKey } = await planeKeys();
  const p: Record<string, unknown> = { jti: crypto.randomUUID(), ...payload };
  // Drop BEFORE constructing: SignJWT copies the payload, so a later delete would not reach the token.
  if (drop && drop in p) delete p[drop];
  let t = new SignJWT(p).setProtectedHeader({ alg: 'EdDSA', kid: KID });
  if (drop !== 'iss') t = t.setIssuer(PLANE);
  if (drop !== 'aud') t = t.setAudience([APP_AUD, `${PLANE}/api/auth/oauth2/userinfo`]);
  if (drop !== 'iat') t = t.setIssuedAt();
  if (drop !== 'exp') t = t.setExpirationTime('5m');
  return t.sign(privateKey);
}

beforeEach(() => __resetJwksCacheForTests());

describe('the plane claim contract, as superpipeline reads it', () => {
  it('pins the fixture version', () => {
    expect(fixture.version, 'contract fixture changed: diff it, fix org-plane.ts, then bump').toBe(FIXTURE_VERSION);
  });

  it.each(Object.entries(fixture.examples))('verifies the %s example verbatim', async (_name, example) => {
    const claims = await verifyOrgPlaneToken(await sign(example as Record<string, unknown>), CFG, APP_AUD, fetchImpl);
    expect(claims).not.toBeNull();
    for (const [k, v] of Object.entries(example)) expect(claims![k as keyof typeof claims]).toEqual(v);
  });

  it.each(fixture.always)('refuses a token missing the always-present claim %s', async (name) => {
    const token = await sign({ ...fixture.examples.human_oauth }, name);
    expect(await verifyOrgPlaneToken(token, CFG, APP_AUD, fetchImpl)).toBeNull();
  });

  it('never needs the removed tenant claim', async () => {
    expect(fixture.removed).toContain('tenant');
    expect('tenant' in fixture.examples.human_oauth).toBe(false);
  });
});

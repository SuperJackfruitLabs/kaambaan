import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { orgPlaneMode, verifyOrgPlaneToken, entitles, type OrgPlaneConfig } from '../src/auth/org-plane';
import { __resetJwksCacheForTests, verifyHubToken } from '../src/auth/hub-jwt';
import { PLANE, PLANE_JWKS, APP_AUD, MCP_AUD, ORG, HUMAN, PLANE_ENV, planeKeys, planeToken } from './helpers/org-plane';

const CFG: OrgPlaneConfig = { issuer: PLANE, jwksUrl: PLANE_JWKS, audience: APP_AUD, mcpAudience: MCP_AUD, url: PLANE };

let calls: string[] = [];
let jwksUp = true;
const fetchImpl = (async (input: RequestInfo | URL) => {
  const url = String(input);
  calls.push(url);
  if (url === PLANE_JWKS && jwksUp) {
    return new Response((await planeKeys()).jwksBody, { headers: { 'content-type': 'application/json' } });
  }
  return new Response('down', { status: 503 });
}) as unknown as typeof fetch;

beforeEach(() => {
  __resetJwksCacheForTests();
  calls = [];
  jwksUp = true;
});

describe('orgPlaneMode — the one switch', () => {
  it('is off when ORG_PLANE_ISSUER is unset, whatever else is set', () => {
    expect(orgPlaneMode({ ...PLANE_ENV, ORG_PLANE_ISSUER: undefined })).toEqual({ kind: 'off' });
    expect(orgPlaneMode({ ...PLANE_ENV, ORG_PLANE_ISSUER: '  ' })).toEqual({ kind: 'off' });
  });

  it('is invalid — not off — when the issuer is set and anything else is missing or unsafe', () => {
    for (const broken of [
      { ORG_PLANE_JWKS_URL: undefined },
      { ORG_PLANE_AUDIENCE: '' },
      { ORG_PLANE_URL: 'not a url' },
      { ORG_PLANE_JWKS_URL: 'http://accounts.test/api/auth/jwks' }, // plain http off loopback
      { ORG_PLANE_ISSUER: 'ftp://accounts.test' },
    ]) {
      expect(orgPlaneMode({ ...PLANE_ENV, ...broken }).kind, JSON.stringify(broken)).toBe('invalid');
    }
  });

  it('is on with every value, and derives the MCP audience from the app audience', () => {
    expect(orgPlaneMode(PLANE_ENV)).toEqual({ kind: 'on', cfg: CFG });
  });

  it('keeps the issuer EXACT — a trailing slash is a different issuer, not a typo to forgive', () => {
    const mode = orgPlaneMode({ ...PLANE_ENV, ORG_PLANE_ISSUER: `${PLANE}/` });
    expect(mode.kind === 'on' && mode.cfg.issuer).toBe(`${PLANE}/`);
  });
});

describe('verifyOrgPlaneToken', () => {
  it('accepts aud as an array containing the audience', async () => {
    const claims = await verifyOrgPlaneToken(await planeToken(), CFG, APP_AUD, fetchImpl);
    expect(claims?.sub).toBe(HUMAN);
    expect(claims?.org).toBe(ORG);
    expect(entitles(claims!)).toBe(true);
  });

  it('accepts aud as a plain string', async () => {
    expect(await verifyOrgPlaneToken(await planeToken({}, { aud: APP_AUD }), CFG, APP_AUD, fetchImpl)).not.toBeNull();
  });

  it('refuses a token minted for the MCP resource at the app, and the reverse', async () => {
    expect(await verifyOrgPlaneToken(await planeToken({}, { aud: MCP_AUD }), CFG, APP_AUD, fetchImpl)).toBeNull();
    expect(await verifyOrgPlaneToken(await planeToken({}, { aud: APP_AUD }), CFG, MCP_AUD, fetchImpl)).toBeNull();
  });

  it('refuses a token minted for another product (the hub)', async () => {
    expect(await verifyOrgPlaneToken(await planeToken({}, { aud: 'https://hub.agentpod.dev' }), CFG, APP_AUD, fetchImpl)).toBeNull();
  });

  it('refuses another issuer, including a prefix of ours', async () => {
    expect(await verifyOrgPlaneToken(await planeToken({}, { iss: `${PLANE}/api/auth` }), CFG, APP_AUD, fetchImpl)).toBeNull();
  });

  it('refuses any algorithm but EdDSA, before fetching keys', async () => {
    const hs = await new SignJWT({ sub: HUMAN, principalKind: 'human', org: ORG, ent: ['superpipeline'], mayDispatch: [], mayGrantReach: false, jti: 'x' })
      .setProtectedHeader({ alg: 'HS256', kid: 'plane-kid-1' })
      .setIssuer(PLANE).setAudience(APP_AUD).setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length!!'));
    expect(await verifyOrgPlaneToken(hs, CFG, APP_AUD, fetchImpl)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('refuses a hub-shaped token that carries tenant instead of org', async () => {
    const hubShaped = await planeToken({ org: undefined, tenant: 'fleet_0123456789abcdef0123' });
    expect(await verifyOrgPlaneToken(hubShaped, CFG, APP_AUD, fetchImpl)).toBeNull();
  });

  it.each([
    ['sub', { sub: 'user_not_a_principal' }],
    ['principalKind', { principalKind: 'robot' }],
    ['org', { org: 'fleet_0123456789abcdef0123' }],
    ['ent', { ent: 'superpipeline' }],
    ['mayDispatch', { mayDispatch: ['agt_local'] }],
    ['mayGrantReach', { mayGrantReach: 'yes' }],
    ['jti', { jti: undefined }],
  ])('refuses a malformed or missing %s', async (_name, over) => {
    expect(await verifyOrgPlaneToken(await planeToken(over), CFG, APP_AUD, fetchImpl)).toBeNull();
  });

  it('reports ent without superpipeline as verified-but-not-entitled (the 403 is the caller\'s)', async () => {
    const claims = await verifyOrgPlaneToken(await planeToken({ ent: ['agentpod'] }), CFG, APP_AUD, fetchImpl);
    expect(claims).not.toBeNull();
    expect(entitles(claims!)).toBe(false);
  });

  it('verifies offline once the key set is warm — zero network calls, even with the plane down', async () => {
    await verifyOrgPlaneToken(await planeToken(), CFG, APP_AUD, fetchImpl);
    calls = [];
    jwksUp = false;
    expect(await verifyOrgPlaneToken(await planeToken(), CFG, APP_AUD, fetchImpl)).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it('refetches exactly once for an unknown kid, then refuses', async () => {
    await verifyOrgPlaneToken(await planeToken(), CFG, APP_AUD, fetchImpl);
    calls = [];
    const stranger = (await generateKeyPair('EdDSA')).privateKey;
    expect(await verifyOrgPlaneToken(await planeToken({}, { kid: 'rotated-in', key: stranger }), CFG, APP_AUD, fetchImpl)).toBeNull();
    expect(calls).toEqual([PLANE_JWKS]);
  });

  it('fetches the configured JWKS URL, not one derived from the issuer', async () => {
    const custom = { ...CFG, jwksUrl: `${PLANE}/keys` };
    const seen: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response((await planeKeys()).jwksBody, { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect(await verifyOrgPlaneToken(await planeToken(), custom, APP_AUD, f)).not.toBeNull();
    expect(seen).toEqual([`${PLANE}/keys`]);
  });

  it('does not let a plane token pass the hub verifier (no dual-accept by accident)', async () => {
    expect(await verifyHubToken(await planeToken(), { issuer: PLANE, audience: APP_AUD, fetch: fetchImpl })).toBeNull();
  });
});

import { env } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { __resetJwksCacheForTests } from '../../src/auth/hub-jwt';
import type { Env } from '../../src/env';

/** A local Organization plane: an Ed25519 key, its JWKS, and tokens shaped as contract §2. */
export const PLANE = 'https://accounts.test';
export const PLANE_JWKS = `${PLANE}/api/auth/jwks`;
/** vitest.config.ts pins APP_URL to this origin; the plane audience is configured to match. */
export const APP_AUD = 'https://api.test';
export const MCP_AUD = `${APP_AUD}/mcp`;
export const ORG = 'org_00000000000000000a01';
export const OTHER_ORG = 'org_00000000000000000b02';
export const HUMAN = 'prn_000000000000000000a1';
export const AGENT = 'prn_000000000000000000a2';
export const SERVICE = 'prn_000000000000000000a3';
export const KID = 'plane-kid-1';

export const PLANE_ENV = {
  ORG_PLANE_ISSUER: PLANE,
  ORG_PLANE_JWKS_URL: PLANE_JWKS,
  ORG_PLANE_AUDIENCE: APP_AUD,
  ORG_PLANE_URL: PLANE,
} as const;

let once: Promise<{ privateKey: CryptoKey; jwksBody: string }> | null = null;
export function planeKeys() {
  once ??= (async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    return { privateKey: pair.privateKey, jwksBody: JSON.stringify({ keys: [{ ...jwk, alg: 'EdDSA', kid: KID }] }) };
  })();
  return once;
}

/**
 * A plane token. Defaults to a human in ORG entitled to superpipeline, with `aud` as the ARRAY the
 * OAuth provider really issues (Gate 1 findings Q1: the resource plus the userinfo endpoint).
 */
export async function planeToken(
  over: Record<string, unknown> = {},
  opts: { aud?: string | string[]; iss?: string; kid?: string; key?: CryptoKey; exp?: string } = {},
): Promise<string> {
  const { privateKey } = await planeKeys();
  const payload: Record<string, unknown> = {
    sub: HUMAN,
    principalKind: 'human',
    org: ORG,
    ent: ['superpipeline'],
    mayDispatch: [],
    mayGrantReach: false,
    jti: crypto.randomUUID(),
    email: 'person@example.com',
    email_verified: true,
    ...over,
  };
  for (const [k, v] of Object.entries(payload)) if (v === undefined) delete payload[k];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: opts.kid ?? KID })
    .setIssuer(opts.iss ?? PLANE)
    .setAudience(opts.aud ?? [APP_AUD, `${PLANE}/api/auth/oauth2/userinfo`])
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey);
}

/** The worker's `env` with plane mode on, for direct calls to resolvers. */
export function planeEnv(over: Record<string, unknown> = {}): Env {
  return { ...env, ...PLANE_ENV, ...over } as unknown as Env;
}

/**
 * Turn plane mode on for `SELF.fetch` tests: set the four vars on the shared `env`, answer the
 * JWKS URL locally, and record every outbound URL so "no network" is measured. `extra` may answer
 * other plane endpoints; returning null passes the request through to the real fetch.
 */
export async function withOrgPlane<T>(
  fn: (calls: string[]) => Promise<T>,
  extra?: (url: string, init?: RequestInit) => Response | null | Promise<Response | null>,
): Promise<T> {
  const { jwksBody } = await planeKeys();
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const bag = env as unknown as Record<string, unknown>;
  Object.assign(bag, PLANE_ENV);
  __resetJwksCacheForTests();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url === PLANE_JWKS) return new Response(jwksBody, { headers: { 'content-type': 'application/json' } });
    const answered = extra ? await extra(url, init) : null;
    if (answered) return answered;
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(PLANE_ENV)) delete bag[k];
    __resetJwksCacheForTests();
  }
}

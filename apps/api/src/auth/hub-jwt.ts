/**
 * Verifying a token issued by the hub, at the edge, without asking anyone.
 *
 * charter decisions/2026-08-15-one-issuer-and-offline-verification.md: one
 * issuer, and every other plane verifies offline against a published JWKS.
 * decisions/2026-08-13-ecosystem-identity.md is where the shape comes from —
 * enforcement local, the token as carrier, and explicitly **not** a
 * policy-service call in the hot path.
 *
 * So the JWKS is fetched once and cached, and a verify that finds the key it
 * needs makes no network call at all. Two consequences follow, and both are
 * deliberate:
 *
 *   - An issuer outage degrades new sign-ins, not work in flight. Proved by
 *     running it (agentpod#331): a Worker verified a token with the issuer
 *     process killed.
 *   - Retiring a signing key does NOT take effect here until this cache
 *     expires. Key deletion is not an emergency revocation lever, and the same
 *     issue measured the lag.
 */

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';

/** The claims kaambaan reads. Names pinned by agentpod fixtures/ecosystem-identity/token_claims.json. */
export interface HubClaims extends JWTPayload {
  sub: string;
  /** What kind of principal `sub` names. */
  principalKind: 'human' | 'agent' | 'service';
  /** AgentPod's isolation boundary — `fleet_…`, NOT one of ours. */
  tenant: string;
}

export interface VerifyOptions {
  /** The issuer's base URL, e.g. https://hub.agentpod.dev */
  issuer: string;
  /** Injectable for tests; defaults to the runtime's fetch. */
  fetch?: typeof fetch;
}

/**
 * The key set, fetched and cached by us rather than by jose.
 *
 * `createRemoteJWKSet` was the obvious choice and is the wrong one here. When a
 * token names a `kid` it has not seen, it kicks off a background reload whose
 * promise rejects independently of the verify — so a `try/catch` around
 * `jwtVerify` catches the verify's failure while the reload's rejection escapes
 * as an **unhandled rejection**. In a test run that fails the run with every
 * assertion passing. In production it is one unhandled rejection per token
 * carrying an unknown key, which is exactly what an attacker sends.
 *
 * Fetching it ourselves makes every failure path synchronous and catchable, and
 * makes the two properties the decision actually asks for explicit rather than
 * inherited from a library's defaults:
 *
 *   - **No network in the verify path** while the cache is warm.
 *   - **Serve the last good set** if a refresh fails, so an issuer outage
 *     degrades new keys rather than stopping work.
 */
interface CachedSet {
  keys: JSONWebKeySet;
  verify: ReturnType<typeof createLocalJWKSet>;
  fetchedAt: number;
}

const cache = new Map<string, CachedSet>();

/** How long a fetched key set is used without re-checking. */
const JWKS_TTL_MS = 10 * 60 * 1000;

/** Test-only: drop the cache so each case starts cold. */
export function __resetJwksCacheForTests(): void {
  cache.clear();
}

async function keySet(opts: VerifyOptions): Promise<CachedSet | null> {
  const now = Date.now();
  const cached = cache.get(opts.issuer);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached;

  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(`${opts.issuer}/api/auth/jwks`);
    if (!res.ok) return cached ?? null;
    const keys = (await res.json()) as JSONWebKeySet;
    if (!Array.isArray(keys?.keys) || keys.keys.length === 0) return cached ?? null;

    const fresh: CachedSet = { keys, verify: createLocalJWKSet(keys), fetchedAt: now };
    cache.set(opts.issuer, fresh);
    return fresh;
  } catch {
    // The issuer is unreachable. A stale set still verifies every token signed
    // by a key we already know, which is the whole point of verifying offline.
    return cached ?? null;
  }
}

/**
 * Verify a hub token and return its claims, or null.
 *
 * Null for every failure, deliberately: a caller that cannot tell "expired"
 * from "forged" cannot accidentally treat one as the other, and neither is a
 * reason to let the request through. What the caller does with null is refuse.
 */
export async function verifyHubToken(
  token: string,
  opts: VerifyOptions
): Promise<HubClaims | null> {
  if (!token) return null;

  // Reject an unsupported algorithm BEFORE asking jose to verify.
  //
  // `jwtVerify` with `algorithms: ['EdDSA']` also rejects it — but by then it
  // has begun resolving a key from the remote set, and that in-flight promise
  // rejects out of band once the verify has already failed. The result is an
  // unhandled rejection that fails a test run whose assertions all passed, and
  // in production an unhandled rejection per malformed token.
  //
  // Checking here means an unsupported `alg` never causes a key lookup at all,
  // which is also the better posture: a caller should not be able to make us
  // fetch anything by sending a header we do not support.
  const header = token.split('.')[0];
  if (!header) return null;
  try {
    const decoded = JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/"))) as {
      alg?: unknown;
    };
    if (decoded.alg !== "EdDSA") return null;
  } catch {
    return null; // not even a JWT
  }

  try {
    const set = await keySet(opts);
    if (!set) return null;

    const { payload } = await jwtVerify(token, set.verify, {
      issuer: opts.issuer,
      audience: opts.issuer,
      // Pinned, never taken from the token's own header — otherwise `alg: none`
      // is a valid token and so is one signed with a key of the caller's
      // choosing.
      algorithms: ['EdDSA'],
    });

    // A token that verifies but names no tenant is not a weaker caller, it is
    // an unresolvable one. Falling back to a default boundary here would hand
    // one tenant's data to a token that never named it.
    const tenant = payload.tenant;
    if (typeof tenant !== 'string' || tenant === '') return null;

    const kind = payload.principalKind;
    if (kind !== 'human' && kind !== 'agent' && kind !== 'service') return null;

    if (typeof payload.sub !== 'string' || payload.sub === '') return null;

    return payload as HubClaims;
  } catch {
    // Expired, wrong issuer, unknown key, bad signature, malformed — all the
    // same answer to a caller: not authorized.
    return null;
  }
}

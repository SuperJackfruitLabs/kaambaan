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

import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';

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
 * Cached per issuer. Module scope, which on Workers means per isolate — the
 * warm-isolate case is the common one, and a cold isolate simply pays one fetch.
 */
const cache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Test-only: drop the cache so each case starts cold. */
export function __resetJwksCacheForTests(): void {
  cache.clear();
}

function keySet(opts: VerifyOptions) {
  const existing = cache.get(opts.issuer);
  if (existing) return existing;

  const set = createRemoteJWKSet(new URL(`${opts.issuer}/api/auth/jwks`), {
    // Long enough that a verify is normally offline; short enough that a
    // rotation propagates without a deploy.
    cacheMaxAge: 10 * 60 * 1000,
    // Do not hammer the issuer when a token names a key we have never seen —
    // that is the shape of an attack as well as of a rotation.
    cooldownDuration: 30 * 1000,
    // jose's supported injection point. An invented symbol here silently does
    // nothing and the fetch goes out anyway — which is exactly how a first pass
    // at this "measured" zero network calls while measuring nothing.
    ...(opts.fetch ? { [customFetch]: opts.fetch } : {}),
  });

  cache.set(opts.issuer, set);
  return set;
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
    const { payload } = await jwtVerify(token, keySet(opts), {
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

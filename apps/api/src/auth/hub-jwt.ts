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
 *
 * That second point is deliberately one-directional. A key ADDED to the
 * published set is picked up right away: a token naming a `kid` this cache
 * has not seen triggers exactly one refetch before rejecting (see `keySet`
 * below). Without that, rotation would be safe to perform but unsafe to rely
 * on for up to `JWKS_TTL_MS` afterwards — the one case where that lag bites is
 * a suspected key compromise, exactly when you need the new key trusted
 * immediately, not in ten minutes. A key REMOVED from the set is a different
 * story: its `kid` is still in our cache, so nothing here notices until the
 * TTL turns over, which is why revocation-via-deletion still is not an
 * emergency lever.
 */

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';

/** The claims kaambaan reads. Names pinned by agentpod fixtures/ecosystem-identity/token_claims.json. */
export interface HubClaims extends JWTPayload {
  /**
   * Present when a SERVICE minted this token while asserting a principal who
   * was not present to sign in — RFC 8693's actor claim. `sub` is still the
   * human; `act.sub` is who spoke for them.
   *
   * Today that is AgentPod's Application Service resolving an approval gate on
   * behalf of whoever tapped a button in a Matrix room, which
   * `charter → decisions/2026-08-14-approvals-cross-planes-as-events.md`
   * requires to arrive as the human rather than as the bridge.
   *
   * **Carries no authority.** Nothing here may grant more because it is present
   * or less because it is absent — the claims beside it are built by the same
   * code path a session token uses, so an assertion can never carry reach the
   * person's own token would not. It is here to be *recorded*: an audit that
   * cannot tell "she approved it" from "the bridge approved it for her" has
   * lost the distinction the separation-of-duties check exists to protect.
   */
  act?: { sub?: string };
  sub: string;
  /** What kind of principal `sub` names. */
  principalKind: 'human' | 'agent' | 'service';
  /** AgentPod's isolation boundary — `fleet_…`, NOT one of ours. */
  tenant: string;
  /**
   * The control pair's first half — bare `prn_…` principal ids, matched by
   * EQUALITY (charter decisions/2026-08-30-an-agent-is-a-principal.md §3; the
   * namespaced, pattern-matched form this used to carry was deleted, not
   * deprecated). Present and possibly empty from an issuer that speaks it;
   * ABSENT from one that does not, and the difference matters — absent must
   * not be read as "permitted nothing".
   */
  mayDispatch?: string[];
  mayGrantReach?: boolean;
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

/**
 * One fetch in flight per issuer, shared by every caller that needs it at the
 * same moment — whether they're here because the TTL lapsed or because a
 * `kid` is missing from an otherwise-fresh set.
 *
 * Without this, a burst of tokens all naming the same just-rotated-in `kid`
 * (the normal shape of traffic right after a rotation — old tokens keep
 * arriving on the old key, new ones start arriving on the new one, all at
 * once) would each fire their own request at the issuer. One rotation should
 * cost the issuer one extra request, not one per in-flight verification.
 */
const inflight = new Map<string, Promise<CachedSet | null>>();

/** Test-only: drop the cache so each case starts cold. */
export function __resetJwksCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

function hasKid(set: CachedSet | undefined, kid: string): boolean {
  return !!set && set.keys.keys.some((key) => key.kid === kid);
}

/** Fetch a fresh set for `opts.issuer`, coalescing concurrent callers onto one request. */
function fetchFresh(opts: VerifyOptions): Promise<CachedSet | null> {
  const existing = inflight.get(opts.issuer);
  if (existing) return existing;

  const promise = (async (): Promise<CachedSet | null> => {
    const doFetch = opts.fetch ?? fetch;
    try {
      const res = await doFetch(`${opts.issuer}/api/auth/jwks`);
      if (!res.ok) return null;
      const keys = (await res.json()) as JSONWebKeySet;
      if (!Array.isArray(keys?.keys) || keys.keys.length === 0) return null;

      const fresh: CachedSet = { keys, verify: createLocalJWKSet(keys), fetchedAt: Date.now() };
      cache.set(opts.issuer, fresh);
      return fresh;
    } catch {
      return null;
    }
  })();

  inflight.set(opts.issuer, promise);
  promise.finally(() => {
    // Only the fetch that's still current clears the slot — otherwise a fetch
    // that finishes after a newer one has already started could delete the
    // newer one's in-flight entry out from under it.
    if (inflight.get(opts.issuer) === promise) inflight.delete(opts.issuer);
  });
  return promise;
}

async function keySet(opts: VerifyOptions, kid: string): Promise<CachedSet | null> {
  const now = Date.now();
  const cached = cache.get(opts.issuer);
  const isFresh = !!cached && now - cached.fetchedAt < JWKS_TTL_MS;

  if (isFresh && hasKid(cached, kid)) return cached;

  if (isFresh) {
    // The TTL hasn't lapsed, but this `kid` isn't in the set we're holding —
    // the signature of a rotation since our last fetch. Refetch once. A
    // failure here does NOT fall back to the set we already have: that set is
    // by definition the one missing this key, so serving it stale would just
    // relocate the same wrong rejection rather than fix it, while quietly
    // making "the refetch failed" indistinguishable from "the key doesn't
    // exist". Fail closed instead — reject, and let the next attempt retry.
    return await fetchFresh(opts);
  }

  // Cold cache or the TTL genuinely expired: the existing periodic refresh.
  // An issuer outage degrades new keys, not verification of tokens signed by
  // a key we already hold.
  const fresh = await fetchFresh(opts);
  return fresh ?? cached ?? null;
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

  // Reject an unsupported algorithm, or a header naming no `kid` at all,
  // BEFORE asking jose to verify or touching the key set.
  //
  // `jwtVerify` with `algorithms: ['EdDSA']` also rejects a bad alg — but by
  // then it has begun resolving a key from the remote set, and that in-flight
  // promise rejects out of band once the verify has already failed. The
  // result is an unhandled rejection that fails a test run whose assertions
  // all passed, and in production an unhandled rejection per malformed token.
  //
  // Requiring a string `kid` here matters more now than it used to: `kid` is
  // what decides whether we refetch. A token with no `kid` (or a non-string
  // one) can never match anything in the set, so if it reached `keySet` it
  // would look exactly like a rotation and trigger a refetch — meaning a
  // flood of headers with no `kid` would be a flood of requests at the
  // issuer. Rejecting it here, before any key lookup, closes that off.
  const header = token.split('.')[0];
  if (!header) return null;
  let kid: string;
  try {
    const decoded = JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/"))) as {
      alg?: unknown;
      kid?: unknown;
    };
    if (decoded.alg !== "EdDSA") return null;
    if (typeof decoded.kid !== "string" || decoded.kid === "") return null;
    kid = decoded.kid;
  } catch {
    return null; // not even a JWT
  }

  try {
    const set = await keySet(opts, kid);
    if (!set) return null;

    // `keySet` already refetched once if `kid` was missing; if it's STILL
    // missing, stop here rather than handing it to `jwtVerify`. This removes
    // the COMMON case (the kid exists nowhere we've fetched from) before it
    // can reach jose's local key resolver, which throws synchronously from
    // inside an async function when no candidate matches — and adopting that
    // rejected promise through the implicit `return` in `createLocalJWKSet`
    // costs one microtask, long enough for this runtime's rejection tracking
    // to flag it as unhandled before our own `catch` below gets to see it.
    //
    // It is NOT a complete guard, and does not claim to be: `hasKid` compares
    // only the `kid` string, while jose's own matching also requires `alg`,
    // `use`, `key_ops` and `kty`/`crv` to agree. A `kid` collision across
    // differently-typed keys — plausible mid-rotation, e.g. an issuer reusing
    // a `kid` value across an algorithm change — passes this guard and still
    // reaches jose's synchronous throw below. The token is still rejected
    // either way (the outer `catch` below handles it one tick later); the
    // residual is a noisier rejection path for that one case, not a wrongly
    // admitted token. Widening `hasKid` to mirror jose's full matching
    // criteria was considered and rejected: duplicating a library's matching
    // rules in our own code, where they will drift from the library's own, is
    // a worse defect than the warning it would remove.
    if (!hasKid(set, kid)) return null;

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

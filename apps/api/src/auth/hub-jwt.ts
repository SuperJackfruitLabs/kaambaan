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

/** The claims superpipeline reads. Names pinned by agentpod fixtures/ecosystem-identity/token_claims.json. */
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

  /**
   * How the subject authenticated, as OIDC's authentication-methods reference.
   *
   * `["device"]` means the token was minted by exchanging a long-lived device
   * credential — the mechanism
   * `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md`
   * accepted on 2026-09-20 so that a person at a terminal stops signing in
   * through a browser every five minutes.
   *
   * **A device-minted token authenticates API calls and may not become a
   * session here.** `signInFromHubToken` refuses on it, for the same reason it
   * refuses `act`: a thirty-day cookie should stand for somebody who was
   * present at an authorize flow, and a device credential is a file on a
   * laptop. The accepted record calls a stolen device credential "worse than a
   * stolen token", bounded by what the exchange checks rather than by five
   * minutes; letting one grow into a month-long session in this plane would
   * undo the bounding that makes the concession narrow.
   *
   * Absent on every token minted today. This field and the refusal that reads
   * it ship BEFORE the hub can produce one, so there is never a window in which
   * a device credential can be turned into a session.
   */
  amr?: string[];
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
  /**
   * The address the issuer holds for this principal, and whether the issuer has
   * checked that the person reading mail there is this principal.
   *
   * **Both optional, and that is permanent rather than transitional.** A token
   * minted before the hub grew these claims carries neither, and the hub-callback
   * sign-in has to keep working for one: an already-linked principal resolves
   * from `sub` alone and never reads either field.
   *
   * `email_verified` is a verdict, not a formality. It is the only thing
   * standing between "the issuer says this person's address is X" and "whoever
   * can make the issuer say that owns the account at X", so the one consumer
   * (`hub-oauth.ts`) compares it against `true` rather than testing it for
   * truthiness — absent is not verified, and neither is the string "false".
   */
  email?: string;
  email_verified?: boolean;
  /**
   * OAuth's space-delimited scope list — agentpod token_claims.json v7, `conditional`. Read only by
   * `resolveHubService`. Absent means no scope; a value this plane does not know is ignored.
   */
  scope?: string;
}

export interface VerifyOptions {
  /** The issuer's base URL, e.g. https://hub.agentpod.dev */
  issuer: string;
  /**
   * This deployment's own public origin, which the token must name in `aud`.
   *
   * **Required, with no default, and that is the point of the field.** The check used to ask for
   * `opts.issuer` — the same value as `issuer` — which every token the hub mints carries by
   * construction, so it passed for every token ever issued: one obtained by another client, for
   * another purpose, presented here, verified. An audience that equals the issuer is not an
   * audience check; it is the issuer check, written twice.
   *
   * Optional-with-a-fallback was considered and rejected. A fallback to `issuer` restores the old
   * behaviour for any caller that forgets the field, silently and in exactly the case that
   * matters — so the type requires it and the compiler names every call site instead.
   *
   * Callers derive it with `planeAudience()`, never by hand.
   */
  audience: string;
  /** Injectable for tests; defaults to the runtime's fetch. */
  fetch?: typeof fetch;
}

/**
 * What `verifyJws` needs: the issuer's exact `iss`, where its keys live, and the audience demanded.
 * Shared by every issuer this plane trusts — the hub today, the Organization plane after cutover
 * (`org-plane.ts`) — so both take the same hardened path.
 */
export interface JwsOptions {
  issuer: string;
  /** Where the key set lives. The cache is keyed by this, not by the issuer. */
  jwksUrl: string;
  audience: string;
  /** Claims jose must find. The hub path asks for exp+iat; the plane path adds jti and sub. */
  requiredClaims: string[];
  fetch?: typeof fetch;
}

/**
 * The origin this deployment answers on, as both the audience it demands and the `redirect_uri`
 * it registers.
 *
 * **One expression, used for both, on purpose.** The hub matches `redirect_uri` as a whole string
 * against its registry, and now issues a token whose `aud` names this plane; if the origin we
 * register and the origin we demand were derived differently they could disagree, and the failure
 * would be a token that verifies nowhere while every setting looks right. `hub-oauth.ts`'s
 * `hubConfig` uses this same function for the redirect.
 *
 * `APP_URL` first, the request's own origin second. The fallback keeps a deployment that never set
 * it working, but a deployment reachable on more than one host — a custom domain and a
 * `workers.dev` one — MUST set it: otherwise the audience demanded depends on which host the
 * caller happened to type, and a token minted for the registered origin is refused on the other.
 * superpipeline's own `wrangler.jsonc` pins it for that reason.
 */
export function planeAudience(request: Request, env: { APP_URL?: string }): string {
  return env.APP_URL || new URL(request.url).origin;
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
 * One fetch in flight per key-set URL, shared by every caller that needs it at the
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

/** Fetch a fresh set from `opts.jwksUrl`, coalescing concurrent callers onto one request. */
function fetchFresh(opts: JwsOptions): Promise<CachedSet | null> {
  const existing = inflight.get(opts.jwksUrl);
  if (existing) return existing;

  const promise = (async (): Promise<CachedSet | null> => {
    const doFetch = opts.fetch ?? fetch;
    try {
      const res = await doFetch(opts.jwksUrl);
      if (!res.ok) return null;
      const keys = (await res.json()) as JSONWebKeySet;
      if (!Array.isArray(keys?.keys) || keys.keys.length === 0) return null;

      const fresh: CachedSet = { keys, verify: createLocalJWKSet(keys), fetchedAt: Date.now() };
      cache.set(opts.jwksUrl, fresh);
      return fresh;
    } catch {
      return null;
    }
  })();

  inflight.set(opts.jwksUrl, promise);
  promise.finally(() => {
    // Only the fetch that's still current clears the slot — otherwise a fetch
    // that finishes after a newer one has already started could delete the
    // newer one's in-flight entry out from under it.
    if (inflight.get(opts.jwksUrl) === promise) inflight.delete(opts.jwksUrl);
  });
  return promise;
}

async function keySet(opts: JwsOptions, kid: string): Promise<CachedSet | null> {
  const now = Date.now();
  const cached = cache.get(opts.jwksUrl);
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
 * Header check, key lookup and signature/iss/aud/exp verification shared by every issuer this
 * plane trusts, returning the verified payload or null.
 *
 * Null for every failure, deliberately: a caller that cannot tell "expired"
 * from "forged" cannot accidentally treat one as the other, and neither is a
 * reason to let the request through. What the caller does with null is refuse.
 *
 * jose's `audience` option accepts a token whose `aud` is a string equal to it OR an array
 * containing it (issuer contract §2).
 */
export async function verifyJws(token: string, opts: JwsOptions): Promise<JWTPayload | null> {
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
      // This plane, not the issuer. See `VerifyOptions.audience` for why the two were the same
      // value until 2026-09-20 and why that made the check vacuous. Do not "simplify" it back.
      audience: opts.audience,
      requiredClaims: opts.requiredClaims,
      // Pinned, never taken from the token's own header — otherwise `alg: none`
      // is a valid token and so is one signed with a key of the caller's
      // choosing.
      algorithms: ['EdDSA'],
    });
    return payload;
  } catch {
    // Expired, wrong issuer, unknown key, bad signature, malformed — all the
    // same answer to a caller: not authorized.
    return null;
  }
}

/** Verify a hub token and return its claims, or null. */
export async function verifyHubToken(
  token: string,
  opts: VerifyOptions
): Promise<HubClaims | null> {
  const payload = await verifyJws(token, {
    issuer: opts.issuer,
    jwksUrl: `${opts.issuer}/api/auth/jwks`,
    audience: opts.audience,
    requiredClaims: ['exp', 'iat'],
    fetch: opts.fetch,
  });
  if (!payload) return null;

  // A token that verifies but names no tenant is not a weaker caller, it is
  // an unresolvable one. Falling back to a default boundary here would hand
  // one tenant's data to a token that never named it.
  const tenant = payload.tenant;
  if (typeof tenant !== 'string' || tenant === '') return null;

  const kind = payload.principalKind;
  if (kind !== 'human' && kind !== 'agent' && kind !== 'service') return null;

  if (typeof payload.sub !== 'string' || payload.sub === '') return null;

  return payload as HubClaims;
}

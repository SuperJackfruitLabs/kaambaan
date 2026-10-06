/**
 * Walking through the hub's front door from a domain its cookie will never reach.
 *
 * superpipeline runs on `superpipeline.dev`; the hub's session cookie is `Domain=.agentpod.dev`,
 * `SameSite=Lax`. Those are different registrable domains, so the browser never attaches that
 * cookie to a cross-site `fetch` — which is why `hubToken()`'s direct call to
 * `GET /api/auth/token` has returned nothing in production since the day it was written, and why
 * every card queued from the deployed UI has carried no authority, silently.
 *
 * What Lax still permits is **top-level navigation**. So the browser *goes* to the hub instead of
 * *calling* it, the hub reads its own first-party cookie, and a one-time code rides back here in
 * the redirect. See agentpod's
 * `docs/superpowers/specs/2026-09-02-cross-domain-token-handoff-design.md`.
 *
 * Three routes, one job each:
 *
 *   POST /hub/connect   mint a PKCE verifier + state, keep them HttpOnly, answer with the hub
 *                       authorize URL for the page to navigate to.
 *   GET  /hub/callback  the hub's redirect lands here: check `state`, spend the code for a token
 *                       server-to-server, verify it, sign the person in, and hand it on.
 *   GET  /hub/token     the SPA reads the token it was handed, and learns whether this
 *                       deployment has a hub at all. Same-origin, this Worker's own cookie — no
 *                       hub cookie involved.
 *
 * **The verifier is minted here and never leaves this Worker.** The design sketch had the page
 * generate it into `sessionStorage`, which cannot work: the exchange is server-to-server (the hub
 * refuses any exchange request carrying an `Origin` header, and strips its CORS headers off that
 * response so a page could not read the answer anyway), so the verifier has to be somewhere this
 * Worker can read at callback time. An HttpOnly cookie is that somewhere, and it is strictly
 * better than `sessionStorage`: a code read out of an address bar, a history entry or a `Referer`
 * is then worth nothing to anyone but this Worker, even to script running on this origin.
 *
 * **Nothing here is mandatory.** `HUB_ISSUER` unset means a standalone superpipeline, and every route
 * below answers 503 without reaching for anything — the same posture the rest of the hub-token
 * path takes (`env.ts`, migration 0003). A board with no hub keeps working exactly as it did.
 */
import type { Env } from '../env';
import { verifyHubToken, planeAudience } from './hub-jwt';
import {
  ensurePersonalWorkspace,
  findTenantByExternal,
  findUserByEmail,
  findUserByExternal,
  setUserExternalMapping,
  upsertUserByEmail,
  type UserRecord,
} from '../db/catalog';
import { signSession, sessionSetCookie, SESSION_TTL_MS, readSessionToken, verifySession } from './session';

/**
 * The flow's own secrets, for the sixty seconds between the navigation and the callback.
 *
 * `SameSite=Lax`, not `Strict`: the callback arrives as a top-level navigation redirected from
 * `hub.agentpod.dev`, which is cross-site, and Strict would withhold the cookie exactly then —
 * the same reason `superpipeline_oauth_state` is Lax for the GitHub flow.
 *
 * `Path=/hub` so it is not attached to every board request; only the two routes that need it live
 * under that prefix.
 */
const PKCE_COOKIE = 'superpipeline_hub_pkce';

/**
 * The minted token, waiting for the SPA to come and read it.
 *
 * `SameSite=Strict` here, unlike the one above: nothing legitimate ever sends this cookie on a
 * navigation that started somewhere else, so a top-level navigation from another site must not be
 * able to make `GET /hub/token` answer.
 */
export const TOKEN_COOKIE = 'superpipeline_hub_token';

/** A code lives 60s at the hub; ten minutes is generous for a person reading a sign-in page. */
const PKCE_TTL_S = 600;

/**
 * The hub's registry key for this plane (`HUB_OAUTH_CLIENTS=superpipeline|https://…` on the hub).
 *
 * Defaulted rather than required because it is not a credential and grants nothing on its own —
 * the hub decides whether it knows this client, and an unknown one gets a rendered 400 that says
 * so. Overridable for a deployment registered under another name.
 */
const DEFAULT_CLIENT_ID = 'superpipeline';

/** The path the hub redirects back to. Must match the hub's registry entry byte for byte. */
export const HUB_CALLBACK_PATH = '/hub/callback';

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 bytes of CSPRNG, base64url — 43 characters, which is also the shape the hub demands of the challenge. */
export function random256(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** `code_challenge` = base64url(SHA-256(verifier)); the hub accepts S256 and refuses `plain`. */
export async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}

/**
 * Compare without leaking, in the timing, how much of it was right.
 *
 * Cheap belt and braces. The stored state is single-use — the cookie is cleared on every callback,
 * whatever the outcome — so there is no second attempt for a timing signal to inform.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

interface PkceState {
  /** The verifier, which only this Worker ever sees. */
  v: string;
  /** Our own CSRF token for this flow, echoed back by the hub untouched. */
  s: string;
  /** The exact `redirect_uri` the code was issued for; the exchange must present the same string. */
  r: string;
}

function packPkce(state: PkceState): string {
  return b64url(enc.encode(JSON.stringify(state)));
}

function unpackPkce(raw: string | null): PkceState | null {
  if (!raw) return null;
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const parsed = JSON.parse(json) as Partial<PkceState>;
    if (typeof parsed.v !== 'string' || typeof parsed.s !== 'string' || typeof parsed.r !== 'string') return null;
    if (!parsed.v || !parsed.s || !parsed.r) return null;
    return { v: parsed.v, s: parsed.s, r: parsed.r };
  } catch {
    return null;
  }
}

function pkceSetCookie(value: string): string {
  return `${PKCE_COOKIE}=${value}; Path=/hub; HttpOnly; Secure; SameSite=Lax; Max-Age=${PKCE_TTL_S}`;
}

/** Cleared on EVERY callback, success or refusal, so one navigation buys exactly one attempt. */
function pkceClearCookie(): string {
  return `${PKCE_COOKIE}=; Path=/hub; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function tokenSetCookie(token: string, maxAgeS: number): string {
  return `${TOKEN_COOKIE}=${token}; Path=/hub; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`;
}

/**
 * Where this deployment's hub is, who it says it is, and where the hub sends the code back to.
 *
 * `null` means no hub — a standalone superpipeline, which is a first-class deployment and not a
 * misconfiguration. `HUB_ISSUER` is reused rather than joined by a second setting: one plane has
 * one hub, and the issuer we verify tokens against had better be the issuer we ask for them.
 *
 * `redirect_uri` prefers `APP_URL` over the request's own origin because the hub compares it
 * against its registry as a whole string: a deployment reachable at both `superpipeline.dev` and
 * `superpipeline-api.workers.dev` must send the one that is registered, not whichever host the
 * operator happened to type.
 */
function hubConfig(request: Request, env: Env): { base: string; clientId: string; redirectUri: string } | null {
  if (!env.HUB_ISSUER) return null;
  let base: URL;
  try {
    base = new URL(env.HUB_ISSUER);
  } catch {
    return null;
  }
  // The SAME origin the audience check demands — see `planeAudience`'s comment on why one
  // expression serves both.
  const appOrigin = planeAudience(request, env);
  let redirectUri: string;
  try {
    redirectUri = new URL(HUB_CALLBACK_PATH, appOrigin).toString();
  } catch {
    return null;
  }
  return { base: base.toString().replace(/\/+$/, ''), clientId: env.HUB_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID, redirectUri };
}

function notConfigured(): Response {
  // 503 rather than 404, and the same sentence shape `/auth/login` uses for an unconfigured
  // GitHub app: the route exists, this deployment has no issuer to send anyone to.
  return Response.json({ error: 'No hub is configured for this deployment.' }, { status: 503 });
}

/** The hub's answer to an exchange, as much of it as we read. */
interface ExchangeResult {
  token?: string;
  expiresIn?: number;
  error_description?: string;
}

/**
 * Where the callback sends somebody it could not sign in, and the word it uses to say so.
 *
 * Read by `apps/web/src/lib/sign-in.ts`, which turns it into the sentence on the landing page.
 * The two literals are written twice on purpose rather than shared through a package: this is one
 * query parameter between a Worker and the page it serves, and a domain-model package is the wrong
 * home for HTTP plumbing. Each side pins it in a test, and the cost of drift is a missing notice —
 * today's behaviour — not a broken flow.
 */
const SIGNIN_OUTCOME_PARAM = 'signin';
const SIGNIN_NO_ACCOUNT = 'no-account';

/**
 * Whether this browser is already somebody here, by this Worker's own cookie.
 *
 * HMAC and an expiry check, no database: the question is only whether the person arriving at the
 * callback had a session before it ran, which decides whether a failed identity step is worth a
 * sentence. See its one caller.
 */
async function hasLiveSession(request: Request, env: Env): Promise<boolean> {
  if (!env.SESSION_SECRET) return false;
  const raw = readSessionToken(request);
  if (!raw) return false;
  return (await verifySession(raw, env.SESSION_SECRET)) !== null;
}

/** Whose ids the `sub` of a hub token is. The same string `resolve.ts` matches mappings on. */
const EXTERNAL_SOURCE = 'agentpod';

/**
 * Turn a freshly exchanged hub token into a session cookie, or null if it names nobody here.
 *
 * This is the step the flow was missing. Everything above it walks through the hub's front door
 * and comes back holding a token; until this existed, the callback handed that token to the SPA
 * and stopped — it created no user and minted no session, where the GitHub callback
 * (`auth/routes.ts`) does both from the same shape of evidence. So a person who signed in through
 * the issuer was, to superpipeline, a stranger with a valid credential: `resolveHubUser` gave them
 * `member` under a foreign id, and `POST /v1/boards` refused them.
 *
 * Resolution is in three steps, and the order is the whole design:
 *
 *   1. **By principal.** Once linked, this is the only step that ever runs, and it needs no claim
 *      but `sub`. That is what lets this ship before the hub's new claims are deployed.
 *   2. **By verified email, exactly once.** The riskiest lines in the file — see the guards below.
 *   3. **Create**, when that address belongs to nobody AND this deployment is linked to the fleet
 *      the token names.
 *
 * **Null is an ordinary answer and never an error.** A token carrying no mapping and no verified
 * email resolves nobody, and the caller hands it to the SPA exactly as it did before this
 * function existed. That property is what makes this deployable on a service with no staging
 * environment: the worst case is today's behaviour.
 */
async function signInFromHubToken(
  env: Env,
  token: string,
  fetchImpl: typeof fetch,
  audience: string,
): Promise<string | null> {
  // No issuer means no token to verify against; no secret means nothing to sign a cookie with.
  // Either way this deployment simply does not sign anyone in here, and says so by doing nothing.
  const issuer = env.HUB_ISSUER;
  if (!issuer || !env.SESSION_SECRET) return null;

  // Verified here, not trusted because the hub handed it over a back channel. The exchange proves
  // the code was ours; only the signature proves the claims are the issuer's. `env.HUB_ISSUER`
  // rather than the normalised `cfg.base`, so this and `resolveHubUser` accept exactly the same
  // tokens — a token that signs in must be a token that then works.
  const claims = await verifyHubToken(token, { issuer, audience, fetch: fetchImpl });
  if (!claims) return null;

  // An agent's or a service's token must never become a browser session: since
  // `charter → decisions/2026-08-30-an-agent-is-a-principal.md` a node can exchange its own
  // credential for a token naming an agent principal, so "a valid hub token" and "a person"
  // stopped being the same thing.
  //
  // `resolveHubUser` makes three fail-closed refusals — no issuer, a non-human principal, and a
  // `tenant` claim that maps to no workspace here. This is the second of them, made one step
  // earlier. The third is deliberately NOT made here for the whole function; step 3 below is the
  // only place it applies, and says why the other two steps must stay ungated.
  if (claims.principalKind !== 'human') return null;

  // And never a token a SERVICE minted while speaking FOR somebody. `act` is RFC 8693's actor
  // claim — `sub` is still the human, `act.sub` is who spoke for them — and today that is the
  // Matrix Application Service resolving an approval on behalf of whoever tapped a button in a
  // room (`charter → decisions/2026-08-14-approvals-cross-planes-as-events.md`).
  //
  // Without this, "signs somebody in" means "verifies against the JWKS", which is strictly
  // broader than "somebody just completed an authorize flow". `act` is the one claim that tells
  // those two apart, so refusing on it is the difference between a browser session standing for
  // presence and one standing for a bridge's word. An assertion carries no more reach than the
  // person's own token, so this is not about authority — it is about not handing a thirty-day
  // cookie to a flow nobody was present for, and not writing the adoption mapping (a one-way
  // door) on the strength of one.
  //
  // Unreachable today: an assertion is minted for a service to spend, and nothing puts one
  // through `/hub/callback`'s code exchange. It is here so that it stays unreachable — and so
  // that whoever makes it reachable has to delete a line and say why. `hub-jwt.ts` already types
  // the field, which is what makes this one line rather than a claim-shape debate.
  if (claims.act) return null;

  // And never a token minted from a device credential rather than from somebody
  // standing at an authorize flow. `amr: ["device"]` is the hub's own mark, added when
  // `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md` was
  // accepted on 2026-09-20 — a person at a terminal exchanges a long-lived credential for a
  // five-minute token, exactly as an agent does, instead of opening a browser every five
  // minutes.
  //
  // That credential is a 0600 file on a laptop. It is authority to WORK, and the record that
  // conceded it called a stolen one "worse than a stolen token" precisely because its blast
  // radius is bounded by what the exchange checks rather than by five minutes. Minting a
  // thirty-day cookie from one would hand that stolen file a month in this plane, and would
  // undo the narrowness the concession was granted on.
  //
  // **Unreachable the day it was written, deliberately.** No token carries `amr` yet; this
  // refusal ships before the hub can mint one, so there is no window. That ordering is the
  // mirror of the mistake the suite sign-in plan made earlier the same day — tightening a
  // check before the thing it checks for existed — and it is written down in
  // `agentpod/docs/superpowers/specs/2026-09-20-device-credential-design.md` so neither
  // direction gets rediscovered.
  if (claims.amr?.includes('device')) return null;

  // One canonical form of the address, computed ONCE and used for both the lookup and the create.
  //
  // `addMember` (db/members.ts) stores `input.email.trim().toLowerCase()`, and SQLite compares
  // TEXT under BINARY collation. So an issuer asserting `A.B@Gmail.com` against an invited
  // `a.b@gmail.com` misses the row, falls through to step 3, and silently makes a SECOND user and
  // a second personal workspace for one person. That fails closed rather than open, but it
  // defeats the invite mechanism the catalog is built around, and the documented rollback for
  // this feature — clear two columns on one row — would leave the stray user and tenant behind.
  //
  // This deliberately WIDENS what `email_verified` is trusted for: every case variant of an
  // address is one account here. That is correct under how mail is actually delivered, and it is
  // what `addMember` already assumed — but it is a choice, not a typo fix.
  //
  // Folding here folds only ONE side, and that is not enough on its own: `auth/routes.ts` stores
  // `ghUser.email` verbatim, so the rows this has to find are not all canonical. The other half
  // of the fold lives in `findUserByEmail`'s `COLLATE NOCASE` — see the comment there.
  const email = claims.email?.trim().toLowerCase();

  // 1. By the issuer's subject id (`claims.sub`). Once somebody is linked, no other step runs —
  //    the mapping IS the identity, so a person whose address changed at the hub is still this
  //    row rather than a new one.
  //
  //    `sub` is NOT a principal id, however much it reads like one. The hub's jwt plugin
  //    overwrites `sub` with `session.user.id` after `definePayload` runs
  //    (agentpod apps/hub/src/routes/auth-authorize.ts), so a session or exchange token carries a
  //    Better Auth user id while a station-minted or bridge-asserted token for the SAME human
  //    carries `prn_…`. Only the first kind ever reaches this callback, so the mapping written
  //    here is keyed on the first kind — and a token of the second kind can never match it. Open
  //    question in docs/superpowers/specs/2026-09-20-suite-sign-in-design.md.
  let user: UserRecord | null = await findUserByExternal(env.DB, EXTERNAL_SOURCE, claims.sub);

  if (!user && email && claims.email_verified === true) {
    // `findUserByEmail`, never `upsertUserByEmail`: the latter CREATES when it finds none, so
    // asking it whether someone exists would conjure the very row the guard below is about to
    // inspect — and it selects only `id, email, name`, leaving `externalId` undefined, which
    // would make the has-no-mapping guard pass for everybody.
    const candidate = await findUserByEmail(env.DB, email);

    // 2. Adopt, exactly once. **Both conditions above and here are load-bearing.** Without
    //    `email_verified === true`, anyone who can make the issuer assert an address takes over
    //    the account at that address. Without `!candidate.externalId`, a second principal
    //    captures an account that already belongs to somebody.
    if (candidate && !candidate.externalId) {
      await setUserExternalMapping(env.DB, candidate.id, {
        externalId: claims.sub,
        externalSource: EXTERNAL_SOURCE,
      });
      user = candidate;
    }

    // 3. Create — only when that address belongs to NOBODY.
    //
    //    `users.email` is UNIQUE, so for an address somebody already holds there is no "create":
    //    `upsertUserByEmail` would find that same row and hand it back, and the mapping write
    //    below would then move it to this principal — undoing, one line later, the refusal step 2
    //    had just made. Keying this on `!candidate` rather than on `!user` is what keeps a
    //    refusal refused: `candidate` and `!candidate` are mutually exclusive and jointly
    //    exhaustive, so exactly one of these two steps fires and neither can reopen what the
    //    other closed.
    if (!candidate) {
      // And only into a fleet this deployment is actually linked to — `resolveHubUser`'s third
      // refusal, applied HERE and nowhere else in this function.
      //
      // Without it, a human principal in a fleet nobody has linked to this deployment — who until
      // now held a token cookie worth nothing, because every route refuses on an unmapped tenant —
      // would get a user row, a workspace they own, and a thirty-day session. That is
      // self-registration for anyone the issuer will authenticate.
      //
      // Steps 1 and 2 stay ungated on purpose. Step 1 is somebody a human already linked by hand.
      // Step 2 needs an invitation-shaped signal — a local row that already exists, plus a
      // verified address — where creation from nothing needs none. And gating the whole function
      // would break bootstrap: `PATCH /v1/tenant` is the only thing that writes a tenant mapping
      // and it is human-session-only, so a hub token could never establish the mapping that would
      // make that same hub token resolve.
      const linkedTenant = await findTenantByExternal(env.DB, EXTERNAL_SOURCE, claims.tenant);
      if (linkedTenant) {
        const created = await upsertUserByEmail(env.DB, { email, name: null });
        await setUserExternalMapping(env.DB, created.id, {
          externalId: claims.sub,
          externalSource: EXTERNAL_SOURCE,
        });
        user = created;
      }
    }
  }

  if (!user) return null;

  // From here on, exactly what the GitHub callback does: a workspace to land in, and a session
  // cookie naming it. `ensurePersonalWorkspace` returns the workspace they already have if they
  // have one, so a linked colleague lands in the team's board rather than a personal duplicate.
  const displayName = user.name || user.email;
  const tenant = await ensurePersonalWorkspace(env.DB, user.id, displayName);
  const session = await signSession(
    { userId: user.id, tenantId: tenant.id, name: displayName, exp: Date.now() + SESSION_TTL_MS },
    env.SESSION_SECRET,
  );
  return sessionSetCookie(session, { secure: true });
}

/**
 * Handle a `/hub/*` request, or return null if `path` is not one.
 *
 * `fetchImpl` is injectable for the same reason `auth/github.ts` takes one: a test has to be able
 * to see the outbound calls, including seeing that one was **not** made. There are two of them
 * now rather than one — the code exchange, and the JWKS fetch `signInFromHubToken` needs in order
 * to verify what came back — and both go through this, so a test never reaches for `globalThis`.
 */
export async function handleHubRoute(
  request: Request,
  env: Env,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  if (path === '/hub/connect') {
    // POST, not GET. It mints state and sets a cookie, so it is not something a link, a prefetch
    // or another site's top-level navigation should be able to trigger.
    if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });

    const cfg = hubConfig(request, env);
    if (!cfg) return notConfigured();

    const verifier = random256();
    const state = random256();
    const authorize = new URL('/api/auth/authorize', `${cfg.base}/`);
    authorize.searchParams.set('client', cfg.clientId);
    authorize.searchParams.set('redirect_uri', cfg.redirectUri);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', await challengeFor(verifier));
    authorize.searchParams.set('code_challenge_method', 'S256');

    // The page is told where to go and nothing else. The verifier stays in the cookie, which the
    // page cannot read, so the only thing that can complete this flow is this Worker.
    return Response.json(
      { url: authorize.toString() },
      { headers: { 'Set-Cookie': pkceSetCookie(packPkce({ v: verifier, s: state, r: cfg.redirectUri })) } },
    );
  }

  if (path === HUB_CALLBACK_PATH) {
    if (request.method !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });

    const cfg = hubConfig(request, env);
    if (!cfg) return notConfigured();

    const u = new URL(request.url);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const stored = unpackPkce(readCookie(request, PKCE_COOKIE));

    // Refuse BEFORE the exchange, never after. A callback we did not start is a callback whose
    // code belongs to somebody else's flow, and spending it would be doing the attacker's work:
    // the hub burns a code on redemption whether or not the verifier matches.
    if (!code || !state || !stored || !constantTimeEqual(state, stored.s)) {
      return new Response('This sign-in could not be verified. Please try connecting again.', {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': pkceClearCookie() },
      });
    }

    let result: ExchangeResult | null = null;
    let reachable = true;
    try {
      // Server-to-server, and deliberately no `Origin` header: the hub refuses any exchange
      // carrying one, because a request with an Origin is a browser and a browser must not be
      // able to spend an operator's code. Workers' `fetch` does not add one.
      const res = await fetchImpl(`${cfg.base}/api/auth/token/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: stored.v, redirect_uri: stored.r }),
      });
      const body = (await res.json().catch(() => null)) as ExchangeResult | null;
      // A refusal never yields a token, whatever it put in the body.
      result = res.ok ? body : { error_description: body?.error_description };
    } catch {
      reachable = false;
    }

    if (!reachable) {
      return new Response('The hub could not be reached. Please try connecting again.', {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': pkceClearCookie() },
      });
    }

    if (!result?.token) {
      // The hub's own sentence, when it gave one. A refusal an operator can read is the whole
      // difference between this and the silent failure the flow replaces — `hubToken()` returning
      // null told nobody anything.
      const detail = result?.error_description ? `\n\n${result.error_description}` : '';
      return new Response(`The hub declined to issue a token.${detail}`, {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': pkceClearCookie() },
      });
    }

    // Bounded on both sides: a hub that answered with no `expiresIn`, or a silly one, must not
    // decide how long this browser holds a credential. Five minutes is `TOKEN_TTL`.
    const ttl = Math.max(1, Math.min(typeof result.expiresIn === 'number' ? result.expiresIn : 300, 3600));

    // The token is in hand and proven ours; now read it as proof of WHO, not only of what.
    //
    // Deliberately wrapped, and the catch is not decoration: everything inside it is new, it
    // touches the database, and the one property that makes this change safe to deploy is that a
    // caller who was getting a token before still gets one. A constraint violation or a D1 hiccup
    // in the identity step must cost this flow a session, never the handoff it already had.
    let sessionCookie: string | null = null;
    try {
      sessionCookie = await signInFromHubToken(env, result.token, fetchImpl, planeAudience(request, env));
    } catch (err) {
      sessionCookie = null;
      // Swallowed, but never silently. This deploys to a service with no staging environment, so
      // the live verification has nothing to read except the Worker's logs — and the flow's own
      // symptom is indistinguishable from the ordinary "this token resolves nobody" case: a 302
      // home with a token cookie and no session. Without a line here, a constraint violation or a
      // D1 hiccup that costs somebody their session looks exactly like the feature deciding not
      // to sign them in, forever.
      //
      // No claims, no token, no address in the message: this lands in a log an operator reads,
      // and the useful part is that the identity step threw, not who it threw about.
      console.error('hub sign-in: the identity step threw; handing the token on without a session', err);
    }

    // Same-origin redirect home, like the GitHub callback: it works on whatever domain this
    // deployment answers on, and it leaves nothing in the URL that is worth anything — no token,
    // no code, no state.
    //
    // **The one thing it may carry is the outcome**, and only in the case that would otherwise be
    // silent. `signInFromHubToken` answering null is two different events depending on who asked:
    //
    //   - Somebody who already had a session — the workspace's Connections tab, whose "connect"
    //     button came here for a token and nothing else. Their session was never in question, they
    //     have the token they came for, and there is nothing to report.
    //   - Somebody who arrived signed out — the landing page's "Continue with AgentPod". For them
    //     null is the whole trip failing: they authenticated at the issuer, came back, and would
    //     land on the same sign-in screen they left, with no way to tell a rejection from a
    //     misclick.
    //
    // The discriminator is the request rather than an intent recorded at `/hub/connect`, because
    // *arriving with no session and leaving with no session* is precisely the condition that
    // deserves a sentence — whichever button started the flow, and including the flows nobody has
    // written yet.
    //
    // One outcome value, deliberately. The reasons `signInFromHubToken` declines — no verified
    // email, an address already mapped to another principal, an unlinked fleet — are not all safe
    // to distinguish out loud: telling a stranger which of those applied answers "does an account
    // exist at this address?" for them.
    const signedInHere = sessionCookie !== null || (await hasLiveSession(request, env));
    const location = signedInHere ? '/' : `/?${SIGNIN_OUTCOME_PARAM}=${SIGNIN_NO_ACCOUNT}`;

    const headers = new Headers({ Location: location });
    headers.append('Set-Cookie', pkceClearCookie());
    headers.append('Set-Cookie', tokenSetCookie(result.token, ttl));
    // AS WELL AS the token, never instead of it: the SPA's `GET /hub/token` path is untouched,
    // and a caller this Worker could not resolve to a person is left exactly where it was.
    if (sessionCookie) headers.append('Set-Cookie', sessionCookie);
    return new Response(null, { status: 302, headers });
  }

  if (path === '/hub/token') {
    if (request.method !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });
    // `{ token: null }` rather than a 404: no token is an ordinary answer here, exactly as it is
    // in `hubToken()`. An operator who never connected and a token that expired are the same
    // answer, and neither is an error.
    //
    // `hubConfigured` is the one thing a null token does NOT say, and the UI needs it. A
    // standalone superpipeline and an operator who has simply not connected yet both hold no token,
    // but only one of them should be offered a "Connect to AgentPod" button — the other has
    // nowhere to be sent, and a button that leads nowhere is worse than no button. This Worker is
    // the only place that knows, because `HUB_ISSUER` is its environment and not the page's.
    //
    // It says whether a hub EXISTS, never anything about it: no issuer URL, no client id. A
    // deployment's hub is not a secret, but this response is read by script on the page and there
    // is no reason for it to carry more than the boolean the question needs.
    return Response.json({
      token: readCookie(request, TOKEN_COOKIE),
      hubConfigured: hubConfig(request, env) !== null,
      // How this deployment signs people in; `plane-signin.ts` answers 'org-plane' after cutover.
      signIn: 'github' as const,
    });
  }

  return null;
}

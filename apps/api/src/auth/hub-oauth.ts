/**
 * Walking through the hub's front door from a domain its cookie will never reach.
 *
 * kaambaan runs on `kaambaan.dev`; the hub's session cookie is `Domain=.agentpod.dev`,
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
 *                       server-to-server, hand it on.
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
 * **Nothing here is mandatory.** `HUB_ISSUER` unset means a standalone kaambaan, and every route
 * below answers 503 without reaching for anything — the same posture the rest of the hub-token
 * path takes (`env.ts`, migration 0003). A board with no hub keeps working exactly as it did.
 */
import type { Env } from '../env';

/**
 * The flow's own secrets, for the sixty seconds between the navigation and the callback.
 *
 * `SameSite=Lax`, not `Strict`: the callback arrives as a top-level navigation redirected from
 * `hub.agentpod.dev`, which is cross-site, and Strict would withhold the cookie exactly then —
 * the same reason `kaambaan_oauth_state` is Lax for the GitHub flow.
 *
 * `Path=/hub` so it is not attached to every board request; only the two routes that need it live
 * under that prefix.
 */
const PKCE_COOKIE = 'kaambaan_hub_pkce';

/**
 * The minted token, waiting for the SPA to come and read it.
 *
 * `SameSite=Strict` here, unlike the one above: nothing legitimate ever sends this cookie on a
 * navigation that started somewhere else, so a top-level navigation from another site must not be
 * able to make `GET /hub/token` answer.
 */
const TOKEN_COOKIE = 'kaambaan_hub_token';

/** A code lives 60s at the hub; ten minutes is generous for a person reading a sign-in page. */
const PKCE_TTL_S = 600;

/**
 * The hub's registry key for this plane (`HUB_OAUTH_CLIENTS=kaambaan|https://…` on the hub).
 *
 * Defaulted rather than required because it is not a credential and grants nothing on its own —
 * the hub decides whether it knows this client, and an unknown one gets a rendered 400 that says
 * so. Overridable for a deployment registered under another name.
 */
const DEFAULT_CLIENT_ID = 'kaambaan';

/** The path the hub redirects back to. Must match the hub's registry entry byte for byte. */
export const HUB_CALLBACK_PATH = '/hub/callback';

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 bytes of CSPRNG, base64url — 43 characters, which is also the shape the hub demands of the challenge. */
function random256(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** `code_challenge` = base64url(SHA-256(verifier)); the hub accepts S256 and refuses `plain`. */
async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}

/**
 * Compare without leaking, in the timing, how much of it was right.
 *
 * Cheap belt and braces. The stored state is single-use — the cookie is cleared on every callback,
 * whatever the outcome — so there is no second attempt for a timing signal to inform.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
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
 * `null` means no hub — a standalone kaambaan, which is a first-class deployment and not a
 * misconfiguration. `HUB_ISSUER` is reused rather than joined by a second setting: one plane has
 * one hub, and the issuer we verify tokens against had better be the issuer we ask for them.
 *
 * `redirect_uri` prefers `APP_URL` over the request's own origin because the hub compares it
 * against its registry as a whole string: a deployment reachable at both `kaambaan.dev` and
 * `kaambaan-api.workers.dev` must send the one that is registered, not whichever host the
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
  const appOrigin = env.APP_URL || new URL(request.url).origin;
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
 * Handle a `/hub/*` request, or return null if `path` is not one.
 *
 * `fetchImpl` is injectable for the same reason `auth/github.ts` takes one: the exchange is the
 * only outbound call here and a test has to be able to see it — including seeing that it was
 * **not** made.
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

    // Same-origin redirect home, like the GitHub callback: it works on whatever domain this
    // deployment answers on, and it leaves nothing in the URL — no token, no code, no state.
    const headers = new Headers({ Location: '/' });
    headers.append('Set-Cookie', pkceClearCookie());
    headers.append('Set-Cookie', tokenSetCookie(result.token, ttl));
    return new Response(null, { status: 302, headers });
  }

  if (path === '/hub/token') {
    if (request.method !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });
    // `{ token: null }` rather than a 404: no token is an ordinary answer here, exactly as it is
    // in `hubToken()`. An operator who never connected and a token that expired are the same
    // answer, and neither is an error.
    //
    // `hubConfigured` is the one thing a null token does NOT say, and the UI needs it. A
    // standalone kaambaan and an operator who has simply not connected yet both hold no token,
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
    });
  }

  return null;
}

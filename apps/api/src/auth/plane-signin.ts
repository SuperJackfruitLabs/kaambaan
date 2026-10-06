/**
 * Signing in to the hosted app through the Organization plane (contract §3.1): an OAuth 2.1
 * public client, `superpipeline-web`, authorization code + PKCE S256, `resource` on every token
 * request. Inert unless ORG_PLANE_ISSUER is set; while it is set the GitHub flow in `routes.ts`
 * is unreachable, because this handler answers `/auth/login` and `/auth/callback` first.
 *
 * **Two audiences, two tokens.** One token carries one audience (contract §3.1). The app token
 * (`aud` = ORG_PLANE_AUDIENCE) is what the SPA sends here to carry `mayDispatch`. The contract
 * also lets `superpipeline-web` request the hub's resource, so the assignee picker can keep calling
 * `GET {hub}/api/fleet/dispatchable`: that is a SECOND refresh-token grant with
 * `resource=<HUB_ISSUER>`, made right after the first, always with the newest (rotated) refresh
 * token, never concurrently with it. It is best-effort: a plane that will not mint it leaves the
 * person signed in with no picker, which the SPA already treats as an ordinary answer.
 */
import type { Env } from '../env';
import { planeAudience } from './hub-jwt';
import { random256, challengeFor, constantTimeEqual, readCookie, TOKEN_COOKIE } from './hub-oauth';
import { entitles, orgPlaneMode, verifyOrgPlaneToken, type OrgPlaneConfig } from './org-plane';
import { ensureOrgTenant, provisionOrgHuman } from './org-tenancy';
import { productNotEnabled } from './org-plane-resolve';
import { signSession, sessionSetCookie, sessionClearCookie, SESSION_TTL_MS } from './session';

export const PLANE_CLIENT_ID = 'superpipeline-web';
export const PLANE_CALLBACK_PATH = '/auth/callback';
const PKCE_COOKIE = 'superpipeline_plane_pkce';
const REFRESH_COOKIE = 'superpipeline_plane_refresh';
/** The hub-audience access token, for the assignee picker. Never sent to this Worker's API. */
const HUB_AUD_COOKIE = 'superpipeline_plane_hub_token';
const SCOPE = 'openid profile email offline_access';
const REFRESH_MAX_AGE_S = 30 * 24 * 3600;

const pkceCookie = (v: string, maxAge: number) => `${PKCE_COOKIE}=${v}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const tokenCookie = (v: string, maxAge: number) => `${TOKEN_COOKIE}=${v}; Path=/hub; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const hubAudCookie = (v: string, maxAge: number) => `${HUB_AUD_COOKIE}=${v}; Path=/hub; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const refreshCookie = (v: string, maxAge: number) => `${REFRESH_COOKIE}=${v}; Path=/hub; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number }

function text(status: number, body: string, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}

async function tokenRequest(
  cfg: OrgPlaneConfig,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
  resource: string = cfg.audience,
): Promise<TokenResponse | null> {
  try {
    const res = await fetchImpl(`${cfg.url}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...form, client_id: PLANE_CLIENT_ID, resource }).toString(),
      redirect: 'manual',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as TokenResponse;
    return typeof body.access_token === 'string' && body.access_token !== '' ? body : null;
  } catch {
    return null;
  }
}

/** The hub's resource, if this deployment has a hub: `HUB_ISSUER`, which is also the hub's audience. */
function hubResource(env: Env): string | null {
  const raw = (env.HUB_ISSUER ?? '').trim().replace(/\/+$/, '');
  return raw === '' ? null : raw;
}

/**
 * The second grant: a hub-audience token from `refresh`. Null when there is no hub, or the plane
 * declines. The caller keeps `refresh` when this returns null — a refused grant spends nothing.
 */
async function hubAudienceToken(
  cfg: OrgPlaneConfig,
  env: Env,
  refresh: string,
  fetchImpl: typeof fetch,
): Promise<TokenResponse | null> {
  const resource = hubResource(env);
  if (!resource) return null;
  return tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refresh }, fetchImpl, resource);
}

const ttlOf = (t: TokenResponse) => Math.max(1, Math.min(typeof t.expires_in === 'number' ? t.expires_in : 300, 3600));

export async function handlePlaneSignInRoute(
  request: Request,
  env: Env,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  const mode = orgPlaneMode(env);
  if (mode.kind === 'off') return null;
  const owned = ['/auth/login', PLANE_CALLBACK_PATH, '/auth/logout', '/hub/token', '/hub/connect', '/hub/callback'];
  if (!owned.includes(path)) return null;
  if (mode.kind === 'invalid' || !env.SESSION_SECRET) {
    return path.startsWith('/auth/') && path !== '/auth/logout'
      ? text(503, 'Sign-in is not configured on this server.')
      : Response.json({ error: 'sign-in is not configured' }, { status: 503 });
  }
  const { cfg } = mode;
  const redirectUri = new URL(PLANE_CALLBACK_PATH, planeAudience(request, env)).toString();

  if (path === '/auth/login') {
    const verifier = random256();
    const state = random256();
    const authorize = new URL(`${cfg.url}/api/auth/oauth2/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: PLANE_CLIENT_ID, redirect_uri: redirectUri, scope: SCOPE, state,
      code_challenge: await challengeFor(verifier), code_challenge_method: 'S256', resource: cfg.audience,
    })) authorize.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { Location: authorize.toString(), 'Set-Cookie': pkceCookie(`${state}.${verifier}`, 600) } });
  }

  if (path === PLANE_CALLBACK_PATH) {
    const u = new URL(request.url);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const [storedState, verifier] = (readCookie(request, PKCE_COOKIE) ?? '').split('.');
    const clear = { 'Set-Cookie': pkceCookie('', 0) };
    if (!code || !state || !storedState || !verifier || !constantTimeEqual(state, storedState)) {
      return text(400, 'This sign-in could not be verified. Please try again.', clear);
    }
    const tokens = await tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, fetchImpl);
    if (!tokens) return text(400, 'The sign-in service declined to issue a token. Please try again.', clear);

    const claims = await verifyOrgPlaneToken(tokens.access_token!, cfg, cfg.audience, fetchImpl);
    const headers = new Headers(clear);
    if (claims && !entitles(claims)) {
      const refused = productNotEnabled(claims.org);
      refused.headers.append('Set-Cookie', pkceCookie('', 0));
      return refused;
    }
    // Same refusals as `signInFromHubToken`: only a person who was present at an authorize flow.
    if (!claims || claims.principalKind !== 'human' || claims.act) {
      headers.set('Location', '/?signin=no-account');
      return new Response(null, { status: 302, headers });
    }
    const tenantId = await ensureOrgTenant(env.DB, claims.org);
    const human = await provisionOrgHuman(env.DB, tenantId, claims);
    if (!human) {
      headers.set('Location', '/?signin=no-account');
      return new Response(null, { status: 302, headers });
    }
    const name = claims.email ?? 'Member';
    const session = await signSession({ userId: human.userId, tenantId, name, exp: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET);
    headers.set('Location', '/');
    headers.append('Set-Cookie', sessionSetCookie(session, { secure: true }));
    headers.append('Set-Cookie', tokenCookie(tokens.access_token!, ttlOf(tokens)));
    let refresh = tokens.refresh_token;
    if (refresh) {
      const hub = await hubAudienceToken(cfg, env, refresh, fetchImpl);
      if (hub) {
        headers.append('Set-Cookie', hubAudCookie(hub.access_token!, ttlOf(hub)));
        if (hub.refresh_token) refresh = hub.refresh_token;
      }
      headers.append('Set-Cookie', refreshCookie(refresh, REFRESH_MAX_AGE_S));
    }
    return new Response(null, { status: 302, headers });
  }

  if (path === '/auth/logout') {
    const headers = new Headers({ Location: '/' });
    headers.append('Set-Cookie', sessionClearCookie({ secure: true }));
    headers.append('Set-Cookie', tokenCookie('', 0));
    headers.append('Set-Cookie', hubAudCookie('', 0));
    headers.append('Set-Cookie', refreshCookie('', 0));
    return new Response(null, { status: request.method === 'POST' ? 204 : 302, headers });
  }

  if (path === '/hub/token') {
    const answer = (token: string | null, hubToken: string | null, headers?: Headers) =>
      Response.json({ token, hubToken, hubConfigured: true, signIn: 'org-plane' }, headers ? { headers } : undefined);
    let app = readCookie(request, TOKEN_COOKIE);
    let hubTok = readCookie(request, HUB_AUD_COOKIE);
    let refresh = readCookie(request, REFRESH_COOKIE);
    const needHub = !hubTok && hubResource(env) !== null;
    if ((app && !needHub) || !refresh) return answer(app, hubTok);

    // Strictly in sequence, each grant spending the refresh token the previous one returned.
    // Two concurrent grants on one rotating refresh token would look like a replay to the plane.
    const headers = new Headers();
    if (!app) {
      const tokens = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refresh }, fetchImpl);
      if (!tokens) {
        headers.append('Set-Cookie', refreshCookie('', 0));
        return answer(null, null, headers);
      }
      app = tokens.access_token!;
      headers.append('Set-Cookie', tokenCookie(app, ttlOf(tokens)));
      // Rotation: the old refresh token is spent; keep only the new one.
      refresh = tokens.refresh_token ?? null;
    }
    if (needHub && refresh) {
      const hub = await hubAudienceToken(cfg, env, refresh, fetchImpl);
      if (hub) {
        hubTok = hub.access_token!;
        headers.append('Set-Cookie', hubAudCookie(hubTok, ttlOf(hub)));
        if (hub.refresh_token) refresh = hub.refresh_token;
      }
    }
    headers.append('Set-Cookie', refreshCookie(refresh ?? '', refresh ? REFRESH_MAX_AGE_S : 0));
    return answer(app, hubTok, headers);
  }

  if (path === '/hub/connect') {
    if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
    return Response.json({ url: '/auth/login' });
  }

  // /hub/callback: the plane is never configured to redirect here.
  return Response.json({ error: 'not used when signing in through the organization plane' }, { status: 404 });
}

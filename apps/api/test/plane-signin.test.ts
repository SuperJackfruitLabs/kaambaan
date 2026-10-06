import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { planeEnv, planeKeys, planeToken, withOrgPlane, PLANE, PLANE_JWKS, APP_AUD, MCP_AUD, ORG, OTHER_ORG, HUMAN } from './helpers/org-plane';
import { handlePlaneSignInRoute } from '../src/auth/plane-signin';
import { verifySession } from '../src/auth/session';
import { findTenantByExternal, findUserByExternal } from '../src/db/catalog';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';

beforeAll(setupCatalog);
beforeEach(() => __resetJwksCacheForTests());

const SECRET = 'plane-signin-secret';
/** No hub resource by default; the hub-audience tests below set HUB_ISSUER themselves. */
const envOn = (over: Record<string, unknown> = {}) => planeEnv({ APP_URL: APP_AUD, SESSION_SECRET: SECRET, HUB_ISSUER: undefined, ...over });
const HUB_RESOURCE = 'https://hub.test';

/** The plane's token endpoint and JWKS, recording every token request body. */
function plane(answer: () => Record<string, unknown> | null) {
  const tokenRequests: URLSearchParams[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === PLANE_JWKS) return new Response((await planeKeys()).jwksBody, { headers: { 'content-type': 'application/json' } });
    if (url === `${PLANE}/api/auth/oauth2/token`) {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      const body = answer();
      return body ? Response.json(body) : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return new Response('unexpected', { status: 599 });
  }) as unknown as typeof fetch;
  return { impl, tokenRequests };
}

function cookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()) {
    const [pair] = c.split(';');
    const [k, ...v] = pair!.trim().split('=');
    out.set(k!, v.join('='));
  }
  return out;
}

async function login(e = envOn()) {
  const res = (await handlePlaneSignInRoute(new Request('https://api.test/auth/login'), e, '/auth/login'))!;
  const location = new URL(res.headers.get('Location')!);
  return { res, location, pkce: cookies(res).get('superpipeline_plane_pkce')!, state: location.searchParams.get('state')! };
}

async function callback(fake: ReturnType<typeof plane>, e = envOn()) {
  const { pkce, state } = await login(e);
  const req = new Request(`https://api.test/auth/callback?code=c0de&state=${state}`, { headers: { Cookie: `superpipeline_plane_pkce=${pkce}` } });
  return (await handlePlaneSignInRoute(req, e, '/auth/callback', fake.impl))!;
}

describe('plane sign-in — off means GitHub, unchanged', () => {
  it('returns null for every path when ORG_PLANE_ISSUER is unset', async () => {
    for (const p of ['/auth/login', '/auth/callback', '/hub/token', '/hub/connect']) {
      expect(await handlePlaneSignInRoute(new Request(`https://api.test${p}`), { ...env, SESSION_SECRET: SECRET } as never, p)).toBeNull();
    }
  });
});

describe('plane sign-in — authorize', () => {
  it('redirects to the plane as superpipeline-web with PKCE S256 and the app resource', async () => {
    const { res, location, pkce } = await login();
    expect(res.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe(`${PLANE}/api/auth/oauth2/authorize`);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'superpipeline-web',
      redirect_uri: `${APP_AUD}/auth/callback`,
      code_challenge_method: 'S256',
      resource: APP_AUD,
      scope: 'openid profile email offline_access',
    });
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce).toBeTruthy();
  });

  it('never sends anyone to GitHub in plane mode — through the real router', async () => {
    await withOrgPlane(async () => {
      (env as unknown as Record<string, unknown>).SESSION_SECRET = SECRET;
      const res = await SELF.fetch('https://api.test/auth/login', { redirect: 'manual' });
      expect(res.headers.get('Location') ?? '').not.toContain('github.com');
      expect(res.headers.get('Location') ?? '').toContain(`${PLANE}/api/auth/oauth2/authorize`);
      delete (env as unknown as Record<string, unknown>).SESSION_SECRET;
    });
  });

  it('answers 503 — not GitHub — when the switch is set but the configuration is incomplete', async () => {
    const res = await handlePlaneSignInRoute(new Request('https://api.test/auth/login'), envOn({ ORG_PLANE_URL: undefined }), '/auth/login');
    expect(res?.status).toBe(503);
  });
});

describe('plane sign-in — callback', () => {
  it('refuses a callback it did not start, without spending the code', async () => {
    const fake = plane(() => ({ access_token: 'unused' }));
    const req = new Request('https://api.test/auth/callback?code=c&state=forged');
    const res = (await handlePlaneSignInRoute(req, envOn(), '/auth/callback', fake.impl))!;
    expect(res.status).toBe(400);
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it('exchanges with resource and the verifier, then signs the person into the org tenant', async () => {
    const access = await planeToken();
    const fake = plane(() => ({ access_token: access, refresh_token: 'r1', expires_in: 300, token_type: 'Bearer' }));
    const res = await callback(fake);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');
    const sent = fake.tokenRequests[0]!;
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_id')).toBe('superpipeline-web');
    expect(sent.get('resource')).toBe(APP_AUD);
    expect(sent.get('redirect_uri')).toBe(`${APP_AUD}/auth/callback`);
    expect(sent.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const c = cookies(res);
    const session = await verifySession(c.get('superpipeline_session')!, SECRET);
    expect(session?.tenantId).toBe(await findTenantByExternal(env.DB, 'org-plane', ORG));
    expect(session?.userId).toBe((await findUserByExternal(env.DB, 'org-plane', HUMAN))?.id);
    expect(c.get('superpipeline_hub_token')).toBe(access);
    expect(c.get('superpipeline_plane_refresh')).toBe('r1');
  });

  it('answers product_not_enabled when the workspace has not enabled superpipeline', async () => {
    const access = await planeToken({ org: OTHER_ORG, ent: ['agentpod'] });
    const res = await callback(plane(() => ({ access_token: access, expires_in: 300 })));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'product_not_enabled', org: OTHER_ORG });
  });

  it('a fresh sign-in whose token names another org lands in THAT org\'s tenant (workspace switch = re-authorize)', async () => {
    const original = await planeToken();
    const first = await callback(plane(() => ({ access_token: original, expires_in: 300 })));
    const firstSession = await verifySession(cookies(first).get('superpipeline_session')!, SECRET);
    expect(firstSession?.tenantId).toBe(await findTenantByExternal(env.DB, 'org-plane', ORG));
    const switched = await planeToken({ org: 'org_00000000000000000c03' });
    const res = await callback(plane(() => ({ access_token: switched, expires_in: 300 })));
    const session = await verifySession(cookies(res).get('superpipeline_session')!, SECRET);
    expect(session?.tenantId).toBe(await findTenantByExternal(env.DB, 'org-plane', 'org_00000000000000000c03'));
  });

  it.each([
    ['an MCP-audience token', async () => planeToken({}, { aud: MCP_AUD })],
    ['an agent token', async () => planeToken({ principalKind: 'agent' })],
    ['a delegated (act) token', async () => planeToken({ act: { sub: 'prn_000000000000000000ff' } })],
  ])('mints no session from %s', async (_name, mint) => {
    const access = await mint();
    const res = await callback(plane(() => ({ access_token: access, expires_in: 300 })));
    expect(cookies(res).has('superpipeline_session')).toBe(false);
    expect(res.headers.get('Location')).toBe('/?signin=no-account');
  });
});

describe('plane sign-in — the SPA keeps authority past five minutes', () => {
  it('refreshes through the rotating refresh token when the access token cookie has lapsed', async () => {
    const renewed = await planeToken({ mayDispatch: [] });
    const fake = plane(() => ({ access_token: renewed, refresh_token: 'r2', expires_in: 300 }));
    const req = new Request('https://api.test/hub/token', { headers: { Cookie: 'superpipeline_plane_refresh=r1' } });
    const res = (await handlePlaneSignInRoute(req, envOn(), '/hub/token', fake.impl))!;
    expect(await res.json()).toEqual({ token: renewed, hubToken: null, hubConfigured: true, signIn: 'org-plane' });
    expect(fake.tokenRequests[0]!.get('grant_type')).toBe('refresh_token');
    expect(fake.tokenRequests[0]!.get('refresh_token')).toBe('r1');
    expect(fake.tokenRequests[0]!.get('resource')).toBe(APP_AUD);
    expect(cookies(res).get('superpipeline_plane_refresh')).toBe('r2');
  });

  /**
   * A refused refresh (invalid_grant) is NOT a sign-out. With two tabs open, the other tab may
   * already have rotated this refresh token and set a newer cookie; clearing ours here would
   * overwrite that newer cookie with nothing. So the cookie is left alone and the answer says to
   * re-run authorize, which the plane's own session makes silent.
   */
  it('on invalid_grant, leaves the refresh cookie alone and asks for a silent re-authorize', async () => {
    const fake = plane(() => null); // 400 { error: 'invalid_grant' }
    const req = new Request('https://api.test/hub/token', { headers: { Cookie: 'superpipeline_plane_refresh=spent-by-the-other-tab' } });
    const res = (await handlePlaneSignInRoute(req, envOn(), '/hub/token', fake.impl))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null, hubToken: null, hubConfigured: true, signIn: 'org-plane', reauthorize: '/auth/login' });
    expect(cookies(res).has('superpipeline_plane_refresh')).toBe(false);
  });

  it.each([
    ['a 5xx from the plane', async () => new Response('upstream', { status: 502 })],
    ['the plane unreachable', async () => { throw new TypeError('network'); }],
  ])('on %s, keeps the refresh cookie and answers a retryable 503', async (_name, answer) => {
    const impl = (async (input: RequestInfo | URL) => {
      if (String(input) === PLANE_JWKS) return new Response((await planeKeys()).jwksBody, { headers: { 'content-type': 'application/json' } });
      return answer();
    }) as unknown as typeof fetch;
    const req = new Request('https://api.test/hub/token', { headers: { Cookie: 'superpipeline_plane_refresh=still-good' } });
    const res = (await handlePlaneSignInRoute(req, envOn(), '/hub/token', impl))!;
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(await res.json()).toMatchObject({ token: null, signIn: 'org-plane', error: 'plane_unavailable', retryable: true });
    expect(cookies(res).has('superpipeline_plane_refresh')).toBe(false);
  });

  it('serves a live token cookie without calling the plane', async () => {
    const fake = plane(() => null);
    const req = new Request('https://api.test/hub/token', { headers: { Cookie: 'superpipeline_hub_token=abc' } });
    const res = (await handlePlaneSignInRoute(req, envOn(), '/hub/token', fake.impl))!;
    expect((await res.json() as { token: string }).token).toBe('abc');
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it('points the connect button at the same sign-in, and retires /hub/callback', async () => {
    const connect = (await handlePlaneSignInRoute(new Request('https://api.test/hub/connect', { method: 'POST' }), envOn(), '/hub/connect'))!;
    expect(await connect.json()).toEqual({ url: '/auth/login' });
    const cb = (await handlePlaneSignInRoute(new Request('https://api.test/hub/callback'), envOn(), '/hub/callback'))!;
    expect(cb.status).toBe(404);
  });
});

/**
 * Contract §3.1 (amended): `superpipeline-web` MAY also request the hub's resource, as a SECOND
 * token request with the same (current) refresh token — one token carries one audience. It keeps
 * the assignee picker's `GET {hub}/api/fleet/dispatchable` working after cutover. The hub resource
 * is this deployment's `HUB_ISSUER`, which stays configured after cutover for exactly this.
 */
describe('plane sign-in — a second, hub-audience token for the assignee picker', () => {
  /** A plane whose answer depends on the requested resource, rotating the refresh token each time. */
  function byResource(opts: { hubRefuses?: boolean } = {}) {
    const tokenRequests: URLSearchParams[] = [];
    let n = 0;
    const tokens = { app: '', hub: '' };
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === PLANE_JWKS) return new Response((await planeKeys()).jwksBody, { headers: { 'content-type': 'application/json' } });
      if (url === `${PLANE}/api/auth/oauth2/token`) {
        const form = new URLSearchParams(String(init?.body));
        tokenRequests.push(form);
        const resource = form.get('resource');
        if (resource === HUB_RESOURCE && opts.hubRefuses) return Response.json({ error: 'invalid_target' }, { status: 400 });
        n += 1;
        const access = resource === HUB_RESOURCE ? tokens.hub : tokens.app;
        return Response.json({ access_token: access, refresh_token: `r${n + 1}`, expires_in: 300 });
      }
      return new Response('unexpected', { status: 599 });
    }) as unknown as typeof fetch;
    return { impl, tokenRequests, tokens };
  }

  it('signs in, then asks for the hub resource with the rotated refresh token, and keeps the newest', async () => {
    const fake = byResource();
    fake.tokens.app = await planeToken();
    fake.tokens.hub = await planeToken({}, { aud: HUB_RESOURCE });
    const res = await callback(fake as never, envOn({ HUB_ISSUER: HUB_RESOURCE }));
    expect(res.status).toBe(302);
    expect(fake.tokenRequests.map((f) => [f.get('grant_type'), f.get('resource'), f.get('refresh_token')])).toEqual([
      ['authorization_code', APP_AUD, null],
      ['refresh_token', HUB_RESOURCE, 'r2'],
    ]);
    const c = cookies(res);
    expect(c.get('superpipeline_hub_token')).toBe(fake.tokens.app);
    expect(c.get('superpipeline_plane_hub_token')).toBe(fake.tokens.hub);
    expect(c.get('superpipeline_plane_refresh')).toBe('r3');
  });

  it('still signs the person in when the plane will not mint the hub resource', async () => {
    const fake = byResource({ hubRefuses: true });
    fake.tokens.app = await planeToken();
    const res = await callback(fake as never, envOn({ HUB_ISSUER: HUB_RESOURCE }));
    const c = cookies(res);
    expect(c.has('superpipeline_session')).toBe(true);
    expect(c.has('superpipeline_plane_hub_token')).toBe(false);
    expect(c.get('superpipeline_plane_refresh')).toBe('r2');
  });

  it('makes no hub request at all when no hub is configured', async () => {
    const fake = byResource();
    fake.tokens.app = await planeToken();
    await callback(fake as never, envOn());
    expect(fake.tokenRequests).toHaveLength(1);
  });

  it('/hub/token renews both, app first, each with the newest refresh token', async () => {
    const fake = byResource();
    fake.tokens.app = await planeToken();
    fake.tokens.hub = await planeToken({}, { aud: HUB_RESOURCE });
    const req = new Request('https://api.test/hub/token', { headers: { Cookie: 'superpipeline_plane_refresh=r1' } });
    const res = (await handlePlaneSignInRoute(req, envOn({ HUB_ISSUER: HUB_RESOURCE }), '/hub/token', fake.impl))!;
    expect(await res.json()).toEqual({ token: fake.tokens.app, hubToken: fake.tokens.hub, hubConfigured: true, signIn: 'org-plane' });
    expect(fake.tokenRequests.map((f) => [f.get('resource'), f.get('refresh_token')])).toEqual([
      [APP_AUD, 'r1'],
      [HUB_RESOURCE, 'r2'],
    ]);
    expect(cookies(res).get('superpipeline_plane_refresh')).toBe('r3');
  });

  it('/hub/token serves both live cookies without calling the plane', async () => {
    const fake = byResource();
    const req = new Request('https://api.test/hub/token', {
      headers: { Cookie: 'superpipeline_hub_token=app1; superpipeline_plane_hub_token=hub1; superpipeline_plane_refresh=r1' },
    });
    const res = (await handlePlaneSignInRoute(req, envOn({ HUB_ISSUER: HUB_RESOURCE }), '/hub/token', fake.impl))!;
    expect(await res.json()).toEqual({ token: 'app1', hubToken: 'hub1', hubConfigured: true, signIn: 'org-plane' });
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it('/hub/token renews only the hub token when only it has lapsed', async () => {
    const fake = byResource();
    fake.tokens.hub = await planeToken({}, { aud: HUB_RESOURCE });
    const req = new Request('https://api.test/hub/token', { headers: { Cookie: 'superpipeline_hub_token=app1; superpipeline_plane_refresh=r1' } });
    const res = (await handlePlaneSignInRoute(req, envOn({ HUB_ISSUER: HUB_RESOURCE }), '/hub/token', fake.impl))!;
    expect(await res.json()).toEqual({ token: 'app1', hubToken: fake.tokens.hub, hubConfigured: true, signIn: 'org-plane' });
    expect(fake.tokenRequests.map((f) => f.get('resource'))).toEqual([HUB_RESOURCE]);
  });

  it('logout clears the hub-audience cookie too', async () => {
    const res = (await handlePlaneSignInRoute(new Request('https://api.test/auth/logout'), envOn(), '/auth/logout'))!;
    expect(cookies(res).get('superpipeline_plane_hub_token')).toBe('');
  });
});


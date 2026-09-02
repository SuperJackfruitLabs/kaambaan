import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { handleHubRoute } from '../src/auth/hub-oauth';
import type { Env } from '../src/env';

/**
 * The cross-domain token handoff, from this side of it.
 *
 * kaambaan is on `kaambaan.dev` and the hub's session cookie is `SameSite=Lax` on
 * `.agentpod.dev`, so the page can never obtain a token by asking. The operator navigates to the
 * hub instead, and a one-time code comes back here to be spent server-to-server. See
 * `src/auth/hub-oauth.ts`.
 *
 * Two properties carry the security of the whole thing, and both are asserted by watching what
 * does NOT happen:
 *
 *   - **A callback we did not start is never exchanged.** The hub spends a code on redemption
 *     whether or not the verifier matches, so exchanging somebody else's callback would burn their
 *     code for them. A status-only assertion would pass an implementation that refused *after*
 *     calling the hub, so every refusal case asserts the exchange spy was not called at all.
 *   - **The verifier never leaves this Worker.** It is minted here, kept in an HttpOnly cookie,
 *     and appears in exactly one place: the body of a server-to-server POST.
 */

const HUB = 'https://hub.test';
const APP = 'https://kaambaan.test';

function envWith(over: Record<string, unknown> = {}): Env {
  return { HUB_ISSUER: HUB, APP_URL: APP, ...over } as unknown as Env;
}

/** The hub's answer to an exchange, and a record of how it was asked. */
function exchangeStub(answer: Response | (() => never)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (typeof answer === 'function') return answer();
    return answer.clone();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Every `Set-Cookie` on a response.
 *
 * `getSetCookie()` exists on the Workers runtime but not in the `Headers` type `@cloudflare/
 * workers-types` publishes, and reading `headers.get('Set-Cookie')` would silently return only the
 * first — the callback sets two.
 */
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

function cookieOf(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const [pair] = c.split(';');
    const [k, ...v] = pair.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const b64url = (bytes: Uint8Array) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Start a flow and hand back everything the callback will need. */
async function connect(env = envWith()): Promise<{ res: Response; cookie: string; state: string; challenge: string }> {
  const res = await handleHubRoute(new Request(`${APP}/hub/connect`, { method: 'POST' }), env, '/hub/connect');
  if (!res) throw new Error('/hub/connect was not routed');
  const cookie = cookieOf(setCookies(res), 'kaambaan_hub_pkce');
  if (!cookie) throw new Error('no pkce cookie');
  const { url } = (await res.clone().json()) as { url: string };
  const q = new URL(url).searchParams;
  return { res, cookie, state: q.get('state') ?? '', challenge: q.get('code_challenge') ?? '' };
}

function callback(cookie: string | null, query: string, fetchImpl: typeof fetch, env = envWith()) {
  return handleHubRoute(
    new Request(`${APP}/hub/callback?${query}`, { headers: cookie ? { Cookie: `kaambaan_hub_pkce=${cookie}` } : {} }),
    env,
    '/hub/callback',
    fetchImpl,
  );
}

describe('POST /hub/connect', () => {
  it('answers with the hub authorize URL, fully formed', async () => {
    const { res } = await connect();
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const u = new URL(url);
    expect(u.origin).toBe(HUB);
    expect(u.pathname).toBe('/api/auth/authorize');
    expect(u.searchParams.get('client')).toBe('kaambaan');
    expect(u.searchParams.get('redirect_uri')).toBe(`${APP}/hub/callback`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    // 43 characters of base64url — the shape the hub's CODE_CHALLENGE_RE demands.
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps the verifier out of the page entirely', async () => {
    // The design sketch had the page mint this into sessionStorage. It cannot: the exchange is
    // server-to-server, so the verifier has to be somewhere the Worker can read at callback time —
    // and an HttpOnly cookie is both that and strictly better, because a code read out of an
    // address bar is then worth nothing even to script running on this origin.
    const { res } = await connect();
    const body = await res.clone().text();
    expect(body).toBe(JSON.stringify({ url: JSON.parse(body).url }));

    const set = setCookies(res).find((c: string) => c.startsWith('kaambaan_hub_pkce='))!;
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    // Lax, not Strict: the callback arrives redirected from the hub, which is cross-site, and
    // Strict would withhold this cookie at exactly the moment it is needed.
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Path=/hub');
  });

  it('starts a different flow every time', async () => {
    const a = await connect();
    const b = await connect();
    expect(a.state).not.toBe(b.state);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it('refuses a GET — it mints state and sets a cookie', async () => {
    const res = await handleHubRoute(new Request(`${APP}/hub/connect`), envWith(), '/hub/connect');
    expect(res?.status).toBe(405);
  });

  it('answers 503 with no cookie when this deployment has no hub', async () => {
    const res = await handleHubRoute(
      new Request(`${APP}/hub/connect`, { method: 'POST' }),
      envWith({ HUB_ISSUER: undefined }),
      '/hub/connect',
    );
    expect(res?.status).toBe(503);
    expect(setCookies(res!)).toEqual([]);
  });
});

describe('GET /hub/callback', () => {
  it('exchanges the code server-side and hands the token on', async () => {
    const { cookie, state, challenge } = await connect();
    const hub = exchangeStub(json({ token: 'hub.jwt.value', expiresIn: 300 }));

    const res = await callback(cookie, `code=c0de&state=${encodeURIComponent(state)}`, hub.impl);

    expect(hub.calls).toHaveLength(1);
    expect(hub.calls[0].url).toBe(`${HUB}/api/auth/token/exchange`);
    const sent = JSON.parse(String(hub.calls[0].init.body)) as Record<string, string>;
    expect(sent.code).toBe('c0de');
    expect(sent.redirect_uri).toBe(`${APP}/hub/callback`);
    // The verifier the Worker kept is the one the challenge was built from — proof the two halves
    // of the flow are bound together and not merely both present.
    expect(await s256(sent.code_verifier)).toBe(challenge);

    expect(res?.status).toBe(302);
    expect(res?.headers.get('Location')).toBe('/');
    const cookies = setCookies(res!);
    expect(cookieOf(cookies, 'kaambaan_hub_token')).toBe('hub.jwt.value');
    // Spent: one navigation buys one attempt.
    expect(cookieOf(cookies, 'kaambaan_hub_pkce')).toBe('');
  });

  it('sends no Origin header — a browser must not be able to spend a code', async () => {
    // Task 4's hub refuses any exchange carrying an Origin, because that header is what a browser
    // always attaches and a Worker never does. Adding one here would break the flow outright, and
    // it would break it in production only.
    const { cookie, state } = await connect();
    const hub = exchangeStub(json({ token: 't', expiresIn: 300 }));
    await callback(cookie, `code=c0de&state=${encodeURIComponent(state)}`, hub.impl);

    const headers = new Headers((hub.calls[0].init.headers ?? {}) as HeadersInit);
    expect(headers.get('origin')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('refuses a state that does not match, and exchanges NOTHING', async () => {
    // The one case the whole route exists to refuse. The hub burns a code the moment it is
    // redeemed, so exchanging a callback we did not start would spend somebody else's code for
    // them — which is why the assertion is on the spy, not only on the status.
    const { cookie } = await connect();
    const hub = exchangeStub(json({ token: 'must not be issued' }));

    const res = await callback(cookie, 'code=c0de&state=not-the-state-we-minted', hub.impl);

    expect(hub.calls).toHaveLength(0);
    expect(res?.status).toBe(400);
    expect(cookieOf(setCookies(res!), 'kaambaan_hub_token')).toBeNull();
    // Cleared even on refusal, so a guess cannot be retried against the same stored state.
    expect(cookieOf(setCookies(res!), 'kaambaan_hub_pkce')).toBe('');
  });

  it('refuses a callback with no flow behind it, and exchanges NOTHING', async () => {
    const hub = exchangeStub(json({ token: 'must not be issued' }));
    const res = await callback(null, 'code=c0de&state=whatever', hub.impl);
    expect(hub.calls).toHaveLength(0);
    expect(res?.status).toBe(400);
  });

  it('refuses a tampered cookie, and exchanges NOTHING', async () => {
    const hub = exchangeStub(json({ token: 'must not be issued' }));
    const res = await callback('not-base64url-json', 'code=c0de&state=whatever', hub.impl);
    expect(hub.calls).toHaveLength(0);
    expect(res?.status).toBe(400);
  });

  it('refuses a callback carrying no code, and exchanges NOTHING', async () => {
    const { cookie, state } = await connect();
    const hub = exchangeStub(json({ token: 'must not be issued' }));
    const res = await callback(cookie, `state=${encodeURIComponent(state)}`, hub.impl);
    expect(hub.calls).toHaveLength(0);
    expect(res?.status).toBe(400);
  });

  it('cannot be replayed: the second callback has no cookie left to match', async () => {
    const { cookie, state } = await connect();
    const first = exchangeStub(json({ token: 't', expiresIn: 300 }));
    await callback(cookie, `code=c0de&state=${encodeURIComponent(state)}`, first.impl);

    // The browser followed the clear; a replay from anywhere else arrives without it.
    const replay = exchangeStub(json({ token: 'must not be issued' }));
    const res = await callback(null, `code=c0de&state=${encodeURIComponent(state)}`, replay.impl);
    expect(replay.calls).toHaveLength(0);
    expect(res?.status).toBe(400);
  });

  it('passes the hub refusal on in the hub words, and sets no token', async () => {
    // The failure this flow replaces was silent. A refusal an operator can read is the difference.
    const { cookie, state } = await connect();
    const hub = exchangeStub(
      json({ error: 'invalid_grant', error_description: 'That code is not redeemable.' }, 400),
    );

    const res = await callback(cookie, `code=c0de&state=${encodeURIComponent(state)}`, hub.impl);

    expect(res?.status).toBe(400);
    expect(await res!.text()).toContain('That code is not redeemable.');
    expect(cookieOf(setCookies(res!), 'kaambaan_hub_token')).toBeNull();
  });

  it('never sets a token from a refusal that still carried one', async () => {
    const { cookie, state } = await connect();
    const hub = exchangeStub(json({ token: 'smuggled', error_description: 'no' }, 400));
    const res = await callback(cookie, `code=c0de&state=${encodeURIComponent(state)}`, hub.impl);
    expect(res?.status).toBe(400);
    expect(cookieOf(setCookies(res!), 'kaambaan_hub_token')).toBeNull();
  });

  it('says so when the hub cannot be reached, rather than throwing', async () => {
    const { cookie, state } = await connect();
    const hub = exchangeStub(() => {
      throw new Error('network');
    });
    const res = await callback(cookie, `code=c0de&state=${encodeURIComponent(state)}`, hub.impl);
    expect(res?.status).toBe(502);
    expect(cookieOf(setCookies(res!), 'kaambaan_hub_token')).toBeNull();
  });

  it('bounds how long this browser holds a credential, whatever the hub says', async () => {
    const { cookie, state } = await connect();
    const hub = exchangeStub(json({ token: 't', expiresIn: 999999 }));
    const res = await callback(cookie, `code=c0de&state=${encodeURIComponent(state)}`, hub.impl);
    const set = setCookies(res!).find((c: string) => c.startsWith('kaambaan_hub_token='))!;
    expect(set).toContain('Max-Age=3600');
    expect(set).toContain('HttpOnly');
    // Strict, unlike the pkce cookie: nothing legitimate sends this on a navigation that started
    // somewhere else, so another site must not be able to make GET /hub/token answer.
    expect(set).toContain('SameSite=Strict');
  });
});

describe('GET /hub/token', () => {
  it('answers with the token the callback stored', async () => {
    const res = await handleHubRoute(
      new Request(`${APP}/hub/token`, { headers: { Cookie: 'kaambaan_hub_token=hub.jwt.value' } }),
      envWith(),
      '/hub/token',
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ token: 'hub.jwt.value', hubConfigured: true });
  });

  it('answers null rather than an error when there is none', async () => {
    // No token is an ordinary answer, the same way it is in `hubToken()`. An operator who never
    // connected and an expired token are one answer, and neither is a failure.
    const res = await handleHubRoute(new Request(`${APP}/hub/token`), envWith(), '/hub/token');
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ token: null, hubConfigured: true });
  });

  it('says a standalone deployment has no hub, so nothing offers to connect to one', async () => {
    // The distinction a null token cannot make on its own: "you have not connected" and "there is
    // nothing to connect to" look identical from the page, and only one of them should put a
    // "Connect to AgentPod" button in front of an operator. A button that leads nowhere is worse
    // than no button — a standalone kaambaan is a first-class deployment (migration 0003), not a
    // half-configured one.
    const res = await handleHubRoute(
      new Request(`${APP}/hub/token`),
      envWith({ HUB_ISSUER: undefined }),
      '/hub/token',
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ token: null, hubConfigured: false });
  });

  it('says the same for an issuer that is set but is not a URL', async () => {
    // `hubConfig` already fails closed on an unparseable issuer, and every other route answers
    // 503 for it. This one must agree, or the UI would offer a connect that cannot start.
    const res = await handleHubRoute(
      new Request(`${APP}/hub/token`),
      envWith({ HUB_ISSUER: 'not a url' }),
      '/hub/token',
    );
    expect(await res!.json()).toEqual({ token: null, hubConfigured: false });
  });
});

describe('wired into the Worker', () => {
  it('reaches the routes rather than the SPA fallback', async () => {
    // A handler that works in isolation and is not wired to anything is a failure mode this repo
    // has met before. `/hub/*` is in `run_worker_first`; without it the assets layer would answer
    // the hub's redirect with index.html and drop the code on the floor.
    const res = await SELF.fetch('https://api.test/hub/token');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null, hubConfigured: true });
  });

  it('serves a real connect through the Worker, with the deployment issuer', async () => {
    const res = await SELF.fetch('https://api.test/hub/connect', { method: 'POST' });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    // HUB_ISSUER ships in wrangler.jsonc, so the test environment inherits the real one.
    expect(url.startsWith('https://hub.agentpod.dev/api/auth/authorize?')).toBe(true);
    expect(new URL(url).searchParams.get('redirect_uri')).toBe('https://api.test/hub/callback');
  });

  it('leaves a deployment with no issuer connecting to nothing', async () => {
    // HUB_ISSUER ships in wrangler.jsonc, so absence has to be arranged rather than assumed —
    // the same shape `hub-token-endpoint.test.ts` uses for the same reason.
    const bag = env as unknown as Record<string, unknown>;
    const issuer = bag.HUB_ISSUER;
    delete bag.HUB_ISSUER;
    try {
      const res = await SELF.fetch('https://api.test/hub/connect', { method: 'POST' });
      expect(res.status).toBe(503);
    } finally {
      if (issuer !== undefined) bag.HUB_ISSUER = issuer;
    }
  });
});

describe('anything else under /hub/', () => {
  it('is left for someone else to answer', async () => {
    // `index.ts` dispatches on the `/hub/` prefix, so this module returning null rather than a 404
    // is what keeps that prefix from swallowing a path it does not own.
    expect(await handleHubRoute(new Request(`${APP}/hub/whatever`), envWith(), '/hub/whatever')).toBeNull();
  });
});

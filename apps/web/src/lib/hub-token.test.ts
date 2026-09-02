import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hubToken, forgetHubToken, withAuthority, beginHubAuthorization, hubStatus } from './hub-token';

/**
 * Carrying authority from the browser (kaambaan#43, option A).
 *
 * What matters here is not that a token is fetched — it is that **no token is an
 * ordinary answer**. An operator with no hub session, a hub that is down, a
 * deployment with no issuer: the board must keep working in all three, queueing
 * cards without authority, which under enforcement are refused with a reason
 * that says exactly that. A UI that broke instead would push people back to
 * whatever bypasses the control.
 */

function jwtExpiringIn(seconds: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

beforeEach(() => {
  forgetHubToken();
  vi.restoreAllMocks();
});

describe('hubToken', () => {
  it('reads the token our own back end holds, same-origin', async () => {
    // The path that works from kaambaan.dev, and therefore the one asked first:
    // our Worker went to the hub on the operator's behalf and kept the result.
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).startsWith('/hub/token')) {
        return new Response(JSON.stringify({ token: jwtExpiringIn(300) }), { status: 200 });
      }
      return new Response('nope', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    expect(await hubToken()).toBeTruthy();
    // Asked our own origin, and never had to reach the hub from the page at all.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/hub/token');
  });

  it('still asks the hub directly when our back end holds nothing', async () => {
    // Kept rather than deleted: it is the correct path for a deployment that
    // shares the hub's registrable domain, and `credentials: include` is that
    // mechanism — the mint is authorised by a cookie this code cannot read.
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).startsWith('/hub/token')) {
        return new Response(JSON.stringify({ token: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: jwtExpiringIn(300) }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    expect(await hubToken()).toBeTruthy();

    const hubCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/api/auth/token'));
    expect(hubCall).toBeTruthy();
    expect(hubCall?.[1]?.credentials).toBe('include');
  });

  it('reuses a cached token rather than minting one per request', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ token: jwtExpiringIn(300) }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await hubToken();
    await hubToken();
    await hubToken();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes before expiry rather than at it', async () => {
    // A token that expires in 30s is already useless for a request in flight.
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ token: jwtExpiringIn(30) }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await hubToken();
    await hubToken();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('mints once when several requests ask at the same moment', async () => {
    // A board view fires several requests on load; each would otherwise mint.
    let resolve: ((r: Response) => void) | null = null;
    const fetchSpy = vi.fn(
      () => new Promise<Response>((r) => { resolve = r; })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const all = Promise.all([hubToken(), hubToken(), hubToken()]);
    resolve!(new Response(JSON.stringify({ token: jwtExpiringIn(300) }), { status: 200 }));
    await all;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('answers null when the operator has no hub session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));
    expect(await hubToken()).toBeNull();
  });

  it('answers null when the hub is unreachable, rather than throwing', async () => {
    // An issuer outage must not break the board. It degrades to queueing without
    // authority, which is visible and recoverable; a thrown error in the UI is
    // neither.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await hubToken()).toBeNull();
  });

  it('does not cache a token whose expiry it cannot read', async () => {
    // Better to re-fetch than to hold something we cannot schedule around.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ token: 'not.a.jwt' }), { status: 200 })
    ));

    await hubToken();
    await hubToken();
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});

describe('hubStatus', () => {
  it('reports a hub and a token when the operator has connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ token: jwtExpiringIn(300), hubConfigured: true }), { status: 200 })
      ),
    );

    const status = await hubStatus();
    expect(status.configured).toBe(true);
    expect(status.token).toBeTruthy();
  });

  it('reports a hub with no token — the state a connect button exists for', async () => {
    // The distinction the whole field is for. This operator has somewhere to be
    // sent; the next case does not.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ token: null, hubConfigured: true }), { status: 200 })),
    );

    expect(await hubStatus()).toEqual({ configured: true, token: null });
  });

  it('reports no hub on a standalone kaambaan, so nothing offers to connect', async () => {
    // A board with no hub is a first-class deployment (migration 0003). It must
    // render neither button and navigate nowhere, and this is the only signal
    // that says so — `token: null` alone cannot tell it from "not connected".
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ token: null, hubConfigured: false }), { status: 200 })),
    );

    expect(await hubStatus()).toEqual({ configured: false, token: null });
  });

  it('reports no hub when the field is absent altogether', async () => {
    // An older Worker that does not send it. Read as "no hub": showing no
    // button is better than offering a flow that answers 503.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ token: null }), { status: 200 })),
    );

    expect((await hubStatus()).configured).toBe(false);
  });

  it('reports no hub rather than throwing when our own back end cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));

    expect(await hubStatus()).toEqual({ configured: false, token: null });
  });
});

describe('withAuthority', () => {
  it('adds the header when there is authority to carry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ token: jwtExpiringIn(300) }), { status: 200 })
    ));

    const headers = await withAuthority({ 'Content-Type': 'application/json' });
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('leaves the request unchanged when there is none', async () => {
    // Additive, never substitutive: kaambaan still reads its own session cookie,
    // and a board with no hub issuer keeps working exactly as before.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));

    const headers = await withAuthority({ 'Content-Type': 'application/json' });
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('beginHubAuthorization', () => {
  it('navigates top-level to the URL our back end minted', async () => {
    // The Lax carve-out: the browser GOES to the hub rather than calling it, so
    // the hub reads its own first-party cookie. A `fetch` here would be the bug
    // this whole flow exists to fix.
    const authorize =
      'https://hub.agentpod.dev/api/auth/authorize?client=kaambaan&code_challenge_method=S256';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ url: authorize }), { status: 200 }))
    );

    const navigate = vi.fn();
    expect(await beginHubAuthorization(navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith(authorize);
  });

  it('never navigates anywhere on a standalone kaambaan', async () => {
    // A board with no hub configured is a first-class deployment, not a broken
    // one (migration 0003). Our Worker answers 503 and the operator stays
    // exactly where they are — being sent to a hub that does not exist would be
    // strictly worse than the honest "no authority" the board already handles.
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'No hub is configured for this deployment.' }), { status: 503 })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const navigate = vi.fn();
    expect(await beginHubAuthorization(navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('never navigates on a refusal that still carried a URL', async () => {
    // The status is the check, not the shape of the body. Without this the
    // 503 case above would pass for the wrong reason — an error body simply has
    // no `url` in it — and a refusal that happened to carry one would navigate.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ url: 'https://hub.agentpod.dev/api/auth/authorize' }), { status: 503 })
      )
    );

    const navigate = vi.fn();
    expect(await beginHubAuthorization(navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('never navigates when the back end cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));

    const navigate = vi.fn();
    expect(await beginHubAuthorization(navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('never navigates to nowhere when the answer carries no URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));

    const navigate = vi.fn();
    expect(await beginHubAuthorization(navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('asks for the flow to be started rather than starting it in the page', async () => {
    // The verifier is minted by the Worker and kept in a cookie this code cannot
    // read, so all that crosses this boundary is a URL. Asserted as "we POST to
    // our own origin and send nothing", because a page that had a verifier to
    // send would be a page an XSS could take one from.
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ url: 'https://hub.agentpod.dev/api/auth/authorize' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await beginHubAuthorization(vi.fn());

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/hub/connect');
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
});

describe('a failed handoff', () => {
  it('leaves hubToken() answering null rather than throwing', async () => {
    // The Worker refused the callback (a state mismatch, a spent code, a hub
    // that declined) so no token cookie was ever set. `hubToken()` must answer
    // the way it answers for a board with no hub at all: null, no throw, and the
    // card is queued without authority rather than not queued.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('/hub/token')
          ? new Response(JSON.stringify({ token: null }), { status: 200 })
          : new Response('Unauthorized', { status: 401 })
      )
    );

    await expect(hubToken()).resolves.toBeNull();
    await expect(withAuthority({ 'Content-Type': 'application/json' })).resolves.toEqual({
      'Content-Type': 'application/json',
    });
  });
});

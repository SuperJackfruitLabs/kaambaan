import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hubToken, forgetHubToken, withAuthority } from './hub-token';

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
  it('fetches a token and sends the hub session cookie', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ token: jwtExpiringIn(300) }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);

    expect(await hubToken()).toBeTruthy();

    // `credentials: include` is the whole mechanism: the mint is authorised by a
    // cookie this code cannot read, on an origin the hub allows explicitly.
    expect(fetchSpy.mock.calls[0]?.[1]?.credentials).toBe('include');
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

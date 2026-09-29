import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setAgentPrincipal, setWorkspaceFleet, getWorkspace, issueAgentToken, revokeAgentToken, getAgents, getHubPrincipals, getBoard, resolveGate, setUnauthorizedHandler, BOARD_TEMPLATES } from './api';
import { capabilityTag } from '@superpipeline/contract';
import { forgetHubToken } from './hub-token';

/**
 * The two agent-list actions task 4 wires up: linking a suite principal, and revoking a token.
 * Both are plain human-session requests (no `withAuthority`, unlike `createCard`/`moveCard`) —
 * console actions, not something an agent's own credential could ever carry.
 */
beforeEach(() => {
  vi.restoreAllMocks();
  // `hubToken()` caches across calls by design; a token left over from one test
  // would let the next one pass without ever asking for authority.
  forgetHubToken();
});

/** A hub token the caching in `hub-token.ts` will accept and keep. */
function jwtExpiringIn(seconds: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).replace(/=+$/, '');
  return `header.${payload}.signature`;
}

describe('setAgentPrincipal', () => {
  it('PATCHes the agent with the principal id', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await setAgentPrincipal('agt_1', 'prn_0123456789abcdef0123');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/agents/agt_1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ externalId: 'prn_0123456789abcdef0123' });
  });

  it('sends null to clear a mapping — a real request, not a client-side no-op', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await setAgentPrincipal('agt_1', null);

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({ externalId: null });
  });

  it('surfaces the raw response so a caller can read the server\'s own refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'externalId must look like prn_ followed by 20 lowercase hex characters' }), { status: 400 })),
    );

    const res = await setAgentPrincipal('agt_1', 'not-a-principal');
    expect(res.ok).toBe(false);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/prn_/);
  });
});

describe('setWorkspaceFleet', () => {
  it('PATCHes /v1/tenant with the fleet id', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await setWorkspaceFleet('fleet_0123456789abcdef0123');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/tenant');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ externalId: 'fleet_0123456789abcdef0123' });
  });

  it('sends null to unlink — a real request, not a client-side no-op', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await setWorkspaceFleet(null);

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({ externalId: null });
  });

  it("surfaces the server's own refusal for a malformed fleet id", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'externalId must look like fleet_ followed by 20 lowercase hex characters' }), { status: 400 })),
    );

    const res = await setWorkspaceFleet('not-a-fleet');
    expect(res.ok).toBe(false);
    expect(((await res.json()) as { error: string }).error).toMatch(/fleet_/);
  });
});

describe('getWorkspace', () => {
  it('reads the workspace so an operator can see whether it is linked, and to what', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ tenant: { id: 't1', slug: 's', name: 'W', externalId: 'fleet_0123456789abcdef0123', externalSource: 'agentpod' } }), { status: 200 })),
    );

    const w = await getWorkspace();
    expect(w?.externalId).toBe('fleet_0123456789abcdef0123');
    expect(w?.externalSource).toBe('agentpod');
  });

  it('answers null rather than throwing when the workspace cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    expect(await getWorkspace()).toBeNull();
  });
});

describe('revokeAgentToken', () => {
  it('DELETEs the specific token, not the agent', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    await revokeAgentToken('agt_1', 'tok_1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/agents/agt_1/tokens/tok_1');
    expect(init?.method).toBe('DELETE');
  });
});

describe('getAgents', () => {
  it('passes through the principal mapping and active token ids the console needs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              agents: [
                { id: 'agt_1', name: 'Bot', capabilities: ['research'], externalId: 'prn_0123456789abcdef0123', externalSource: 'org-plane', tokenIds: ['tok_1'] },
                { id: 'agt_2', name: 'Idle', capabilities: [], externalId: null, externalSource: null, tokenIds: [] },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const agents = await getAgents();
    expect(agents[0]).toMatchObject({ externalId: 'prn_0123456789abcdef0123', tokenIds: ['tok_1'] });
    // The empty state is a real value, not something the caller has to invent.
    expect(agents[1]).toMatchObject({ externalId: null, tokenIds: [] });
  });
});

/**
 * The agent picker's source of truth.
 *
 * It used to ask the hub's admin list with `credentials: 'include'`, which could
 * not work from `superpipeline.dev` — the hub's cookie is `SameSite=Lax` on another
 * registrable domain — and would not have worked with a token either, since the
 * hub's admin middleware does not accept one. It now asks the endpoint built for
 * the question, and carries the token as a Bearer.
 */
describe('getHubPrincipals', () => {
  /** Answers `/hub/token` with `token`, and the hub endpoint with `hubBody`. */
  function stubFetch(token: string | null, hubResponse: Response) {
    const spy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).startsWith('/hub/token')) {
        return new Response(JSON.stringify({ token, hubConfigured: token !== null }), { status: 200 });
      }
      return hubResponse.clone();
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('asks the dispatchable endpoint, carrying the token as a Bearer', async () => {
    const token = jwtExpiringIn(300);
    const spy = stubFetch(
      token,
      new Response(JSON.stringify({ agents: [{ id: 'prn_a', handle: 'alpha', displayName: 'Alpha' }] }), { status: 200 }),
    );

    expect(await getHubPrincipals()).toEqual([{ id: 'prn_a', handle: 'alpha', displayName: 'Alpha' }]);

    const call = spy.mock.calls.find((c) => String(c[0]).includes('/api/fleet/dispatchable'));
    expect(call).toBeTruthy();
    expect((call?.[1]?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    // Never the admin list: it needs a cookie that cannot travel here, and it is
    // the wrong set — every principal in the fleet rather than the usable ones.
    expect(spy.mock.calls.some((c) => String(c[0]).includes('/api/admin/principals'))).toBe(false);
    // And no cookie is asked for. The Bearer is the whole credential.
    expect(call?.[1]?.credentials).toBeUndefined();
  });

  it('answers null without touching the hub when there is no token', async () => {
    // A standalone superpipeline makes no cross-origin request at all: with nothing
    // to send, the answer is the same and the request is pure noise.
    const spy = stubFetch(null, new Response(JSON.stringify({ agents: [] }), { status: 200 }));

    expect(await getHubPrincipals()).toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('/api/fleet/dispatchable'))).toBe(false);
  });

  it('answers null, not an error, when the endpoint refuses', async () => {
    // An expired token, a suspended principal, a hub that has forgotten us. The
    // section renders no picker; nothing throws and nothing is shown as broken.
    stubFetch(jwtExpiringIn(300), new Response('Unauthorized', { status: 401 }));

    expect(await getHubPrincipals()).toBeNull();
  });

  it('answers null when the hub cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).startsWith('/hub/token')) {
          return new Response(JSON.stringify({ token: jwtExpiringIn(300), hubConfigured: true }), { status: 200 });
        }
        throw new Error('network');
      }),
    );

    expect(await getHubPrincipals()).toBeNull();
  });

  it('reads an empty grant as an empty list, not as no hub', async () => {
    // `[]` and `null` mean different things to the caller: nothing to offer
    // versus nowhere to ask. An operator with no grant sees "every agent in the
    // fleet already has one here", not a connect button.
    stubFetch(jwtExpiringIn(300), new Response(JSON.stringify({ agents: [] }), { status: 200 }));

    expect(await getHubPrincipals()).toEqual([]);
  });
});

/**
 * The templates that shipped asked for nine capabilities no agent in any fleet held — `publish`,
 * `test`, `deploy`, `triage`, `support`, `send`, `extract`, `transform`, `load` — while the agent
 * UI offered three, of which two overlapped. That gap is where the mismatch began.
 */
describe('board templates ask only for capabilities a workspace can staff', () => {
  const VOCABULARY = new Set(['analysis', 'code', 'research', 'writing', 'security', 'planning', 'onboarding']);

  it('names nothing outside the fleet vocabulary', () => {
    const asked = new Set(
      BOARD_TEMPLATES.flatMap((t) => t.stages)
        .filter((s) => s.ownerKind === 'capability' && s.owner)
        .map((s) => s.owner!),
    );
    expect([...asked].filter((c) => !VOCABULARY.has(c))).toEqual([]);
  });

  it('spells every capability the way a capability is spelled', () => {
    // Routing is exact string equality against an agent's capability, so a stage owner that is
    // not already a tag can never match one.
    for (const t of BOARD_TEMPLATES) {
      for (const s of t.stages) {
        if (s.ownerKind === 'capability' && s.owner) expect(s.owner).toBe(capabilityTag(s.owner));
      }
    }
  });

  it('gives every template a first stage a person controls', () => {
    // A card lands in the first stage the moment it is created. If that stage were an agent lane,
    // every card would be claimable before anyone had looked at it.
    for (const t of BOARD_TEMPLATES) {
      const first = [...t.stages].sort((a, b) => a.order - b.order)[0]!;
      expect(first.ownerKind ?? 'human').toBe('human');
    }
  });

  it('keeps stage keys unique within a template', () => {
    for (const t of BOARD_TEMPLATES) {
      const keys = t.stages.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('issueAgentToken', () => {
  it('mints the full credential by default — the body stays empty, as it always was', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ token: 'spa_x', tokenId: 'tok_1' }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await issueAgentToken('agt_1');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/agents/agt_1/tokens');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
  });

  it('asks for a narrower credential when given scopes', async () => {
    // A `run`-only token can finish the card it holds and cannot claim another. It is what a
    // harness driving the board through MCP should carry, and minting is a human act — an agent
    // cannot narrow, or widen, its own.
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ token: 'spa_x', tokenId: 'tok_1', scopes: ['run'] }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const minted = await issueAgentToken('agt_1', ['run']);

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({ scopes: ['run'] });
    expect(minted.scopes).toEqual(['run']);
  });
});

describe('an expired session is noticed, rather than presenting as a dead board', () => {
  beforeEach(() => setUnauthorizedHandler(() => {}));

  it('a 401 on the board read fires the handler', async () => {
    // `authState` is decided once at init and never revisited, so without this a session that
    // expires while a tab is open leaves the app certain it is signed in while every request
    // fails — a board that stopped updating and buttons that do nothing, saying nothing.
    let fired = 0;
    setUnauthorizedHandler(() => { fired++; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));

    await expect(getBoard('brd_1')).rejects.toThrow();
    expect(fired).toBe(1);
  });

  it('a 401 on a gate decision fires it too — that is the click a person actually makes', async () => {
    let fired = 0;
    setUnauthorizedHandler(() => { fired++; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));

    const res = await resolveGate('brd_1', 'gate_1', 'reject');
    expect(res.status).toBe(401);
    expect(fired).toBe(1);
  });

  it('an ordinary refusal is not mistaken for a lost session', async () => {
    // 409 GATE_NOT_PENDING is a real answer about the gate, not about who you are.
    let fired = 0;
    setUnauthorizedHandler(() => { fired++; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'gate is already resolved' } }), { status: 409 })));

    const res = await resolveGate('brd_1', 'gate_1', 'reject');
    expect(res.status).toBe(409);
    expect(fired).toBe(0);
  });

  it('a success fires nothing', async () => {
    let fired = 0;
    setUnauthorizedHandler(() => { fired++; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ card: {} }), { status: 200 })));

    await resolveGate('brd_1', 'gate_1', 'approve');
    expect(fired).toBe(0);
  });
});

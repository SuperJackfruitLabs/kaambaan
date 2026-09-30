import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setAgentPrincipal, setWorkspaceFleet, getWorkspace, issueAgentToken, revokeAgentToken, getAgents, getHubPrincipals, getBoard, resolveGate, setUnauthorizedHandler, BOARD_TEMPLATES, createCard, listLabels, getSchedules, createSchedule, updateSchedule, deleteSchedule, addLink, removeLink, listLinks, archiveCard, unarchiveCard, splitCard } from './api';
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

/**
 * `createCard` gaining `dueAt` (Task 6, Step 0b): the compose form can now set a due date at
 * creation instead of create-then-patch, so a failure between the two round trips can no longer
 * silently drop the date.
 */
describe('createCard', () => {
  // `createCard` sends its request through `withAuthority`, which itself asks `/hub/token` (and,
  // on a deployment with no back-end hand-off, the hub directly) before the real POST — so the
  // call under test is not necessarily `fetchSpy.mock.calls[0]`. Answering everything that is not
  // the cards route with a plain 404 keeps `hubToken()` on its "no authority" path without a
  // second fetch, and picking the call by URL is robust to how many precede it.
  function stubFetch() {
    const spy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/cards')) return new Response(JSON.stringify({ card: {} }), { status: 201 });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('sends dueAt in the body when given', async () => {
    const fetchSpy = stubFetch();

    await createCard('brd_1', 'A card', { dueAt: '2026-12-01' });

    const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/cards'))!;
    expect(JSON.parse(call[1]?.body as string)).toMatchObject({ dueAt: '2026-12-01' });
  });

  it('omits dueAt entirely when not given — a one-line dispatch stays exactly that', async () => {
    const fetchSpy = stubFetch();

    await createCard('brd_1', 'A card');

    const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/cards'))!;
    expect(JSON.parse(call[1]?.body as string)).not.toHaveProperty('dueAt');
  });
});

describe('listLabels', () => {
  it('reads the tenant label catalogue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ labels: [{ id: 'lbl_1', tenantId: 't1', name: 'urgent', colour: '#f00', createdAt: '2026-01-01' }] }), { status: 200 })),
    );

    expect(await listLabels()).toEqual([{ id: 'lbl_1', tenantId: 't1', name: 'urgent', colour: '#f00', createdAt: '2026-01-01' }]);
  });

  it('answers an empty list rather than throwing when the read is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    expect(await listLabels()).toEqual([]);
  });
});

/**
 * Task 10's client for `/v1/boards/:id/schedules[/:scheduleId]` (Task 8/9's recurrence, routed).
 */
describe('getSchedules', () => {
  it('reads a board\'s schedules', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            schedules: [
              { id: 'sch_1', enabled: true, title: 'Sweep', rule: 'daily at 09:00', timezone: 'UTC', overlap: 'skip', nextFireAt: '2026-10-01T09:00:00.000Z', lastFiredAt: null, lastCardId: null, skipCount: 0, priority: 0, labels: [], stageKey: null, spec: {} },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const schedules = await getSchedules('brd_1');
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.id).toBe('sch_1');
  });

  it('answers an empty list rather than throwing when the read is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    expect(await getSchedules('brd_1')).toEqual([]);
  });
});

describe('createSchedule', () => {
  it('POSTs the schedule fields to the board\'s schedules route', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ schedule: {} }), { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    await createSchedule('brd_1', { title: 'Sweep', rule: 'daily at 09:00', timezone: 'UTC', overlap: 'skip' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/boards/brd_1/schedules');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ title: 'Sweep', rule: 'daily at 09:00', timezone: 'UTC', overlap: 'skip' });
  });

  it('surfaces the server\'s own refusal so the form can show the parser\'s message verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'the shortest interval is 5 minutes' } }), { status: 400 })),
    );

    const res = await createSchedule('brd_1', { title: 'x', rule: 'every 2 minutes', timezone: 'UTC', overlap: 'skip' });
    expect(res.ok).toBe(false);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('the shortest interval is 5 minutes');
  });
});

describe('updateSchedule', () => {
  it('PATCHes enabled:false to pause a schedule', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ schedule: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await updateSchedule('brd_1', 'sch_1', { enabled: false });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/boards/brd_1/schedules/sch_1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ enabled: false });
  });
});

describe('deleteSchedule', () => {
  it('DELETEs the schedule', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    await deleteSchedule('brd_1', 'sch_1');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/boards/brd_1/schedules/sch_1');
    expect(init?.method).toBe('DELETE');
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

/**
 * Task 17a: the client for the link routes Task 12 (`addLink`/`removeLink`/`listLinks` on the
 * DO) and Task 16 (cross-board advisory rows in D1) each shipped with no HTTP surface. `addLink`
 * and `removeLink` return the raw response, like `setStages`/`patchStage` do, so a caller can
 * surface the DO's own refusal sentence (a cycle, an existing parent) rather than a generic one.
 */
describe('addLink', () => {
  it('POSTs fromCardId/toCardId/kind to the board\'s links route', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ link: {} }), { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    await addLink('brd_1', 'card_a', 'card_b', 'blocks');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/boards/brd_1/links');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ fromCardId: 'card_a', toCardId: 'card_b', kind: 'blocks' });
  });

  it("surfaces the server's own refusal — a cycle says so, not \"invalid link\"", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'LINK_WOULD_CYCLE', message: 'linking card_a -> card_b (blocks) would close a cycle' } }), { status: 409 })),
    );

    const res = await addLink('brd_1', 'card_a', 'card_b', 'blocks');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('LINK_WOULD_CYCLE');
    expect(body.error.message).toContain('cycle');
  });

  /**
   * Task 17d: `toBoardId` rides the same route — the server decides whether the edge is enforced
   * (the DO) or advisory (Task 16's D1 store) by comparing it to the path's own board, so the
   * wrapper's only job is to pass it through when the caller names one.
   */
  it('includes toBoardId in the body when a cross-board target is named', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ link: { enforced: false } }), { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    await addLink('brd_1', 'card_a', 'card_b', 'blocks', 'brd_2');

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({ fromCardId: 'card_a', toCardId: 'card_b', kind: 'blocks', toBoardId: 'brd_2' });
  });

  it('omits toBoardId from the body when no cross-board target is given', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ link: {} }), { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    await addLink('brd_1', 'card_a', 'card_b', 'blocks');

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({ fromCardId: 'card_a', toCardId: 'card_b', kind: 'blocks' });
  });
});

describe('removeLink', () => {
  it('DELETEs fromCardId/toCardId/kind against the board\'s links route', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await removeLink('brd_1', 'card_a', 'card_b', 'parent');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/boards/brd_1/links');
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(init?.body as string)).toEqual({ fromCardId: 'card_a', toCardId: 'card_b', kind: 'parent' });
  });

  it('includes toBoardId in the body when removing a cross-board edge', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await removeLink('brd_1', 'card_a', 'card_b', 'blocks', 'brd_2');

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({ fromCardId: 'card_a', toCardId: 'card_b', kind: 'blocks', toBoardId: 'brd_2' });
  });
});

describe('listLinks', () => {
  it('reads a card\'s same-board (enforced) and cross-board (advisory) edges', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            links: [{ fromCardId: 'card_a', toCardId: 'card_b', kind: 'blocks', createdAt: '2026-01-01', createdBy: null, enforced: true }],
            externalLinks: [
              {
                fromBoardId: 'brd_1',
                fromCardId: 'card_a',
                toBoardId: 'brd_2',
                toCardId: 'card_c',
                kind: 'blocks',
                enforced: false,
                otherCardTitle: 'Fix the layout',
                otherBoardName: 'Design board',
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await listLinks('brd_1', 'card_a');
    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.enforced).toBe(true);
    expect(result.externalLinks).toHaveLength(1);
    expect(result.externalLinks[0]!.enforced).toBe(false);
    // 17b follow-up: the route resolves the other end's title/board name per row, typed here so
    // a consumer (`buildLinkGroups`) doesn't have to fall back to a bare id in the common case.
    expect(result.externalLinks[0]!.otherCardTitle).toBe('Fix the layout');
    expect(result.externalLinks[0]!.otherBoardName).toBe('Design board');
  });

  it('carries otherCardTitle/otherBoardName as null when the route could not resolve them — a real state, not a missing field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            links: [],
            externalLinks: [
              {
                fromBoardId: 'brd_1',
                fromCardId: 'card_a',
                toBoardId: 'brd_2',
                toCardId: 'card_c',
                kind: 'blocks',
                enforced: false,
                otherCardTitle: null,
                otherBoardName: null,
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await listLinks('brd_1', 'card_a');
    expect(result.externalLinks[0]!.otherCardTitle).toBeNull();
    expect(result.externalLinks[0]!.otherBoardName).toBeNull();
  });

  /**
   * Whole-branch review fix wave (`166abfe`): a same-board `relates` edge is decoration —
   * `blockedWhere` never consults it — so the route now stamps `enforced: kind !== 'relates'`
   * rather than `true` unconditionally, and `Link.enforced` here was corrected from the literal
   * type `true` to `boolean` to match. Kept as a runtime regression check for the pass-through
   * (nothing in `listLinks` computes `enforced`; it is a bare `res.json() as CardLinks`, so this
   * mainly documents the shape a consumer can rely on). NOT a compile-time proof, despite the
   * intuitive appeal of one: `@vitest/expect`'s `toBe<E>(expected: E): void` carries its OWN
   * generic parameter, unconstrained by the assertion subject's type — `expect(x).toBe(false)`
   * type-checks for any `x`, regardless of `x`'s declared type. Verified directly: temporarily
   * reverting `Link.enforced` to the literal `true` and re-running `svelte-check` produced ZERO
   * errors — confirmed against this exact file, whose type-checking `svelte-check` does otherwise
   * catch (sanity-checked with a deliberately bad assignment in the same file, which DID error).
   * So the literal-vs-boolean type fix stands on its own reasoning (already given where `Link` is
   * declared in `api.ts`), not on this test.
   */
  it('a same-board `relates` edge is NOT enforced — the type is `boolean`, not always `true`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            links: [{ fromCardId: 'card_a', toCardId: 'card_b', kind: 'relates', createdAt: '2026-01-01', createdBy: null, enforced: false }],
            externalLinks: [],
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await listLinks('brd_1', 'card_a');
    expect(result.links[0]!.kind).toBe('relates');
    expect(result.links[0]!.enforced).toBe(false);
  });

  it('answers empty arrays rather than throwing when the read is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    expect(await listLinks('brd_1', 'card_a')).toEqual({ links: [], externalLinks: [] });
  });
});

describe('archiveCard', () => {
  it('PATCHes archivedAt with a real timestamp, so the existing "show archived" filter has something to filter', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ card: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await archiveCard('brd_1', 'card_a');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/boards/brd_1/cards/card_a');
    expect(init?.method).toBe('PATCH');
    const body = JSON.parse(init?.body as string) as { archivedAt: string };
    expect(typeof body.archivedAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.archivedAt))).toBe(false);
  });
});

/**
 * Whole-branch review, Minor: un-archiving named as one of three recoveries for a parent parked by
 * an archived child (`board-do.ts:3347`) — the other two had surfaces, this one didn't, so an
 * archived card was a one-way door through the web app even though the route/DO already accept
 * `archivedAt: null`.
 */
describe('unarchiveCard', () => {
  it('PATCHes archivedAt to null, clearing it rather than sending a fresh timestamp', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ card: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await unarchiveCard('brd_1', 'card_a');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/boards/brd_1/cards/card_a');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ archivedAt: null });
  });
});

/**
 * Task 17b: "Add sub-task" reuses Task 15's `POST …/cards/:cardId/split` (one title in, one
 * child out) rather than `createCard` + `addLink('parent')` — `createCard`'s wrapper discards the
 * response body, so it cannot hand back the new card's id to link as a child; `splitCard`'s
 * response already carries the created children in full.
 */
describe('splitCard', () => {
  it('POSTs titles to the card\'s split route', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ children: [] }), { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    await splitCard('brd_1', 'card_a', ['Write the doc']);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/v1/boards/brd_1/cards/card_a/split');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ titles: ['Write the doc'] });
  });

  it('surfaces the server\'s own refusal rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'NOTHING_TO_SPLIT', message: 'every line was blank — nothing to split into' } }), { status: 400 })),
    );

    const res = await splitCard('brd_1', 'card_a', ['   ']);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOTHING_TO_SPLIT');
  });
});

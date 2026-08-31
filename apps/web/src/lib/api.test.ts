import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setAgentPrincipal, setWorkspaceFleet, getWorkspace, revokeAgentToken, getAgents } from './api';

/**
 * The two agent-list actions task 4 wires up: linking a suite principal, and revoking a token.
 * Both are plain human-session requests (no `withAuthority`, unlike `createCard`/`moveCard`) —
 * console actions, not something an agent's own credential could ever carry.
 */
beforeEach(() => {
  vi.restoreAllMocks();
});

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

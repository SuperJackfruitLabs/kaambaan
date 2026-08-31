import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { valuePermitsAgent, grantPermitsAgent } from '../src/auth/grant-match';

/**
 * The control pair, enforced where work is handed out.
 *
 * `charter` → `decisions/2026-08-13-ecosystem-identity.md` Decision 4, and, since 2026-08-30,
 * `decisions/2026-08-30-an-agent-is-a-principal.md` §3: a grant now names bare `prn_…` principal
 * ids, matched by EQUALITY — no per-plane namespace, no wildcard. The two pattern-matched forms
 * this suite used to enforce were deleted, not deprecated.
 *
 * The idea being tested: **authority is captured at the moment of the act**. An
 * agent claims work long after a human queued it and the human is not present,
 * so there is no caller to ask "may you dispatch this?". The answer has to have
 * been written down while it was still askable — which is what `queued_grant`
 * is — and the claim checks the recorded answer, against the PRINCIPAL id the
 * claiming agent maps to (`agents.external_id`), not its local `agt_…` id —
 * nothing outside kaambaan has ever heard of the latter.
 */

const PIPELINE = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'done', name: 'Done', order: 1, ownerKind: 'human' },
];

const dev = (tenant: string, user?: string) => ({
  'X-Tenant-Id': tenant,
  ...(user ? { 'X-User-Id': user } : {}),
  'Content-Type': 'application/json',
});

async function board(tenant: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: dev(tenant, 'usr_owner'),
    body: JSON.stringify({ name: 'CP', stages: PIPELINE }),
  });
  return (await res.json<{ boardId: string }>()).boardId;
}

async function claim(tenant: string, boardId: string, agentId: string) {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
    method: 'POST',
    headers: { ...dev(tenant), 'X-Agent-Id': agentId },
    body: JSON.stringify({ capabilities: ['research'] }),
  });
  return res.json<{ claimed: boolean }>();
}

async function cards(tenant: string, boardId: string) {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: dev(tenant) });
  return (await res.json<{ cards: Array<Record<string, unknown>> }>()).cards;
}

/**
 * Register the local agent a `claim()` call names, so `claim()`'s D1 lookup of
 * `agents.external_id` has a row to find. Mapped to `principalId` when given one — `null` leaves
 * the agent registered but unmapped, which is the ordinary, standalone-kaambaan state.
 */
async function agentMappedTo(tenant: string, agentId: string, principalId: string | null): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO agents (id, tenant_id, name) VALUES (?, ?, ?)`)
    .bind(agentId, tenant, agentId)
    .run();
  await env.DB.prepare(`UPDATE agents SET external_id = ?, external_source = ? WHERE id = ?`)
    .bind(principalId, principalId ? 'org-plane' : null, agentId)
    .run();
}

const ISSUER = 'https://issuer.test';
const FLEET = 'fleet_00000000000000000042';
let signingKey: CryptoKey;
let jwksBody: string;
let realFetch: typeof fetch;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'cp-kid' }] });
});

/** A caller holding a hub token that grants exactly `mayDispatch`. */
async function tokenGranting(mayDispatch: string[]) {
  return new SignJWT({ sub: 'usr_grantee', principalKind: 'human', tenant: FLEET, mayDispatch })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'cp-kid' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime('5m')
    .sign(signingKey);
}

/** Point the Worker at the fake issuer and map the tenant, for one test. */
async function withIssuer(tenantId: string, fn: () => Promise<void>) {
  realFetch = globalThis.fetch;
  (env as unknown as Record<string, unknown>).HUB_ISSUER = ISSUER;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === `${ISSUER}/api/auth/jwks`) {
      return new Response(jwksBody, { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'CP')`)
    .bind(tenantId, `slug-${tenantId}`).run();
  await env.DB.prepare(`UPDATE tenants SET external_source='agentpod', external_id=? WHERE id=?`)
    .bind(FLEET, tenantId).run();
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
    await env.DB.prepare(`UPDATE tenants SET external_source=NULL, external_id=NULL WHERE id=?`).bind(tenantId).run();
  }
}

afterEach(() => {
  delete (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR;
});

describe('matching, which is the fixture\'s contract', () => {
  it('matches a principal id by equality, character for character', () => {
    expect(valuePermitsAgent('prn_0123456789abcdef0123', 'prn_0123456789abcdef0123')).toBe(true);
    expect(valuePermitsAgent('prn_0123456789abcdef0123', 'prn_ffffffffffffffffffff')).toBe(false);
  });

  it('a wildcard is a string that never equals a real id — not a pattern', () => {
    // Patterns were deleted, not deprecated: `hermes:*` silently spanned nodes, and a
    // namespaced wildcard grant once reached a root station that should never have existed
    // (charter decisions/2026-08-30-an-agent-is-a-principal.md §3).
    expect(valuePermitsAgent('*', 'prn_0123456789abcdef0123')).toBe(false);
    expect(valuePermitsAgent('prn_*', 'prn_0123456789abcdef0123')).toBe(false);
    expect(grantPermitsAgent(['prn_*'], 'prn_0123456789abcdef0123')).toBe(false);
  });

  it('a retired per-plane value is simply not equal to any real id — ignored, not denied', () => {
    // The old `kaambaan:` namespace form. It never matches under equality, but its presence
    // alongside a real id must not sink the whole grant: a consumer ignores what it does not
    // recognise, it never denies on it.
    expect(grantPermitsAgent(['kaambaan:agt_x', 'prn_target'], 'prn_target')).toBe(true);
  });

  it('treats no grant and an empty grant alike, and both as no', () => {
    expect(grantPermitsAgent(null, 'prn_target')).toBe(false);
    expect(grantPermitsAgent([], 'prn_target')).toBe(false);
  });

  it('an agent never linked to a principal cannot be named by any grant', () => {
    // Behaviour change, and a correct one: a local agent with no suite identity is not a weaker
    // caller, it is unenumerable — nothing outside kaambaan has ever heard of it.
    expect(grantPermitsAgent(['prn_target'], null)).toBe(false);
  });
});

describe('claiming under enforcement', () => {
  it('hands out work when the queuer\'s token permitted this agent\'s principal', async () => {
    const t = 'tnt_cp1';
    const boardId = await board(t);
    await agentMappedTo(t, 'agt_worker', 'prn_0000000000000000cp01');

    await withIssuer(t, async () => {
      (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';
      const jwt = await tokenGranting(['prn_0000000000000000cp01']);

      const created = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'permitted' }),
      });
      expect(created.status).toBe(201);

      expect((await claim(t, boardId, 'agt_worker')).claimed).toBe(true);
    });
  });

  it('ignores a grant the CLIENT supplies, and records only the verified one', async () => {
    // The hole this closes. If the request body could set `queuedGrant`, any
    // caller could grant themselves everything by asking — authority would come
    // from the claim rather than from the issuer, which is the opposite of the
    // whole design.
    const t = 'tnt_cp_forge';
    const boardId = await board(t);
    await agentMappedTo(t, 'agt_permitted', 'prn_0000000000000forgepr');
    await agentMappedTo(t, 'agt_other', 'prn_0000000000000forgeot');

    await withIssuer(t, async () => {
      (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';
      const jwt = await tokenGranting(['prn_0000000000000forgepr']);

      await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        // A caller asserting authority they were never granted — a wildcard, which the fixture's
        // reject case requires never be read as "every agent".
        body: JSON.stringify({ title: 'forged', queuedGrant: ['prn_*'] }),
      });

      const [card] = await cards(t, boardId);
      expect(card!.queuedGrant).toEqual(['prn_0000000000000forgepr']);
      // And the forged wildcard buys nothing.
      expect((await claim(t, boardId, 'agt_other')).claimed).toBe(false);
    });
  });

  it('refuses, and says so on the card, when the grant does not cover the agent\'s principal', async () => {
    const t = 'tnt_cp2';
    const boardId = await board(t);
    await agentMappedTo(t, 'agt_worker', 'prn_0000000000000000cp02');

    (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';

    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(t, 'usr_owner'),
      body: JSON.stringify({ title: 'not for this agent', queuedGrant: ['prn_0000000000someoneels'] }),
    });

    expect((await claim(t, boardId, 'agt_worker')).claimed).toBe(false);

    // Visible, not silently skipped. A board that looks idle while work sits on
    // it is the failure the decision forbids: a denial must be reported.
    const [card] = await cards(t, boardId);
    expect(card!.state).toBe('input-required');
  });

  it('refuses an agent that has never been linked to a principal, even with a matching-looking grant', async () => {
    // An agent this plane has never mapped to a suite principal cannot be named by ANY grant —
    // there is no id to enumerate. This is the direct behavioural consequence of equality
    // matching on principal ids rather than kaambaan's local `agt_…` id.
    const t = 'tnt_cp_unmapped';
    const boardId = await board(t);
    await agentMappedTo(t, 'agt_nobody', null);

    (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';

    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(t, 'usr_owner'),
      body: JSON.stringify({ title: 'unreachable', queuedGrant: ['agt_nobody'] }),
    });

    expect((await claim(t, boardId, 'agt_nobody')).claimed).toBe(false);
  });

  it('refuses a card queued with no authority at all', async () => {
    // Null is not an empty grant — it means no one with permission ever asked
    // for this to run, which is exactly a session-cookie caller under
    // enforcement.
    const t = 'tnt_cp3';
    const boardId = await board(t);
    await agentMappedTo(t, 'agt_worker', 'prn_0000000000000000cp03');
    (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';

    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(t, 'usr_owner'),
      body: JSON.stringify({ title: 'no authority' }),
    });

    expect((await claim(t, boardId, 'agt_worker')).claimed).toBe(false);
    const [card] = await cards(t, boardId);
    expect(card!.state).toBe('input-required');
  });

  it('hands out the same card when enforcement is off', async () => {
    // The switch, and the reason it is explicit: a deployment that has not
    // populated grants yet must keep working exactly as before. No agent mapping needed —
    // enforcement off means the grant is never even read.
    const t = 'tnt_cp4';
    const boardId = await board(t);

    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(t, 'usr_owner'),
      body: JSON.stringify({ title: 'no authority, no enforcement' }),
    });

    expect((await claim(t, boardId, 'agt_worker')).claimed).toBe(true);
  });

  it('records the grant as granted then, not as it is now', async () => {
    // Authority at the time of the act. A card queued under one grant is not
    // retroactively authorised or deauthorised by a later change, which is what
    // makes this an audit record rather than a cache.
    const t = 'tnt_cp5';
    const boardId = await board(t);
    await agentMappedTo(t, 'agt_worker', 'prn_0000000000000000cp05');

    await withIssuer(t, async () => {
      const jwt = await tokenGranting(['prn_0000000000000000cp05']);
      await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'pinned' }),
      });

      const [card] = await cards(t, boardId);
      expect(card!.queuedGrant).toEqual(['prn_0000000000000000cp05']);
    });
  });
});

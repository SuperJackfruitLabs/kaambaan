import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { valuePermitsAgent, grantPermitsAgent } from '../src/auth/grant-match';

/**
 * The control pair, enforced where work is handed out.
 *
 * `charter` → `decisions/2026-08-13-ecosystem-identity.md` Decision 4, and the
 * namespacing from `decisions/2026-08-15-a-grant-names-an-agent-per-plane.md`.
 *
 * The idea being tested: **authority is captured at the moment of the act**. An
 * agent claims work long after a human queued it and the human is not present,
 * so there is no caller to ask "may you dispatch this?". The answer has to have
 * been written down while it was still askable — which is what `queued_grant`
 * is — and the claim checks the recorded answer.
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
  it('matches this plane\'s namespace, exactly or by prefix', () => {
    expect(valuePermitsAgent('kaambaan:agt_x', 'agt_x')).toBe(true);
    expect(valuePermitsAgent('kaambaan:agt_x', 'agt_y')).toBe(false);
    expect(valuePermitsAgent('kaambaan:*', 'agt_anything')).toBe(true);
  });

  it('ignores another plane\'s namespace rather than denying on it', () => {
    // A plane that refused what it did not understand would break the day a
    // third plane appeared, and a claim is read by more planes over time.
    expect(valuePermitsAgent('agentpod:hermes:*', 'agt_x')).toBe(false);
    expect(grantPermitsAgent(['agentpod:hermes:*'], 'agt_x')).toBe(false);
  });

  it('matches nothing for an unprefixed value', () => {
    // AgentPod's retired format. Honouring it here would mean a half-migrated
    // suite enforcing two different rules depending on which plane read it.
    expect(valuePermitsAgent('agt_x', 'agt_x')).toBe(false);
  });

  it('treats no grant and an empty grant alike, and both as no', () => {
    expect(grantPermitsAgent(null, 'agt_x')).toBe(false);
    expect(grantPermitsAgent([], 'agt_x')).toBe(false);
  });
});

describe('claiming under enforcement', () => {
  it('hands out work when the queuer\'s token permitted this agent', async () => {
    const t = 'tnt_cp1';
    const boardId = await board(t);

    await withIssuer(t, async () => {
      (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';
      const jwt = await tokenGranting(['kaambaan:agt_worker']);

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

    await withIssuer(t, async () => {
      (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';
      const jwt = await tokenGranting(['kaambaan:agt_permitted']);

      await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        // A caller asserting authority they were never granted.
        body: JSON.stringify({ title: 'forged', queuedGrant: ['kaambaan:*'] }),
      });

      const [card] = await cards(t, boardId);
      expect(card!.queuedGrant).toEqual(['kaambaan:agt_permitted']);
      // And the forged wildcard buys nothing.
      expect((await claim(t, boardId, 'agt_other')).claimed).toBe(false);
    });
  });

  it('refuses, and says so on the card, when the grant does not cover the agent', async () => {
    const t = 'tnt_cp2';
    const boardId = await board(t);
    (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';

    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(t, 'usr_owner'),
      body: JSON.stringify({ title: 'not for this agent', queuedGrant: ['kaambaan:agt_someone_else'] }),
    });

    expect((await claim(t, boardId, 'agt_worker')).claimed).toBe(false);

    // Visible, not silently skipped. A board that looks idle while work sits on
    // it is the failure the decision forbids: a denial must be reported.
    const [card] = await cards(t, boardId);
    expect(card!.state).toBe('input-required');
  });

  it('refuses a card queued with no authority at all', async () => {
    // Null is not an empty grant — it means no one with permission ever asked
    // for this to run, which is exactly a session-cookie caller under
    // enforcement.
    const t = 'tnt_cp3';
    const boardId = await board(t);
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
    // populated grants yet must keep working exactly as before.
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

    await withIssuer(t, async () => {
      const jwt = await tokenGranting(['kaambaan:agt_worker']);
      await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'pinned' }),
      });

      const [card] = await cards(t, boardId);
      expect(card!.queuedGrant).toEqual(['kaambaan:agt_worker']);
    });
  });
});

import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { updateAgent } from '../src/db/catalog';

/**
 * A coordinator agent queues work.
 *
 * Every test here is a refusal except three, because every bug in this area grants more than
 * intended. The shape of the thing: an agent may put a card on a board only if the operator named
 * the board, only inside an hourly ceiling, only owned by a human the operator named, and only
 * carrying the dispatch grant the agent itself holds — so an agent can never queue work for a
 * principal it could not have dispatched directly.
 */

const PIPELINE = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'done', name: 'Done', order: 1, ownerKind: 'human' },
];

const ISSUER = 'https://issuer.test';
const PLANE = 'https://api.test';
const FLEET = 'fleet_00000000000000000099';
let signingKey: CryptoKey;
let jwksBody: string;
let realFetch: typeof fetch;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'q-kid' }] });
});

const dev = (tenant: string, user?: string) => ({
  'X-Tenant-Id': tenant,
  ...(user ? { 'X-User-Id': user } : {}),
  'Content-Type': 'application/json',
});

async function board(tenant: string, name = 'Q'): Promise<string> {
  const res = await SELF.fetch(`${PLANE}/v1/boards`, {
    method: 'POST',
    headers: dev(tenant, 'usr_owner'),
    body: JSON.stringify({ name, stages: PIPELINE }),
  });
  return (await res.json<{ boardId: string }>()).boardId;
}

/** A local agent row, mapped to a suite principal so a hub token can resolve to it. */
async function agentRow(tenant: string, agentId: string, principalId: string): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO agents (id, tenant_id, name) VALUES (?, ?, ?)`)
    .bind(agentId, tenant, 'Super Chotu')
    .run();
  await env.DB.prepare(`UPDATE agents SET external_id = ?, external_source = 'org-plane' WHERE id = ?`)
    .bind(principalId, agentId)
    .run();
}

/**
 * A hub token that speaks AS an agent and carries the grant that agent holds.
 *
 * This is the credential a coordinator queues with, and it has to be: the grant is AgentPod's
 * (`fleet grants set`) and travels in the claims. A `spa_` token carries no claims and therefore
 * cannot say what its agent may dispatch — tested below as its own refusal.
 */
async function agentToken(principalId: string, mayDispatch?: string[]) {
  const claims: Record<string, unknown> = { sub: principalId, principalKind: 'agent', tenant: FLEET };
  if (mayDispatch !== undefined) claims.mayDispatch = mayDispatch;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'q-kid' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience([ISSUER, PLANE])
    .setExpirationTime('5m')
    .sign(signingKey);
}

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
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'Q')`)
    .bind(tenantId, `slug-${tenantId}`)
    .run();
  await env.DB.prepare(`UPDATE tenants SET external_source='agentpod', external_id=? WHERE id=?`)
    .bind(FLEET, tenantId)
    .run();
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
    await env.DB.prepare(`UPDATE tenants SET external_source=NULL, external_id=NULL WHERE id=?`).bind(tenantId).run();
  }
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

async function queue(boardId: string, token: string, title: string) {
  const res = await SELF.fetch(`${PLANE}/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ title }),
  });
  return { status: res.status, body: await res.json<Record<string, never>>() };
}

afterEach(() => {
  delete (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR;
});

describe('a coordinator queues a card', () => {
  it('builds the card from the AGENT\'s own grant, owned by the human the operator named', async () => {
    const t = 'tnt_q1';
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, name) VALUES ('usr_rakesh','r@example.test','Rakesh')`).run();
    const boardId = await board(t);
    await agentRow(t, 'agt_chotu', 'prn_chotu0000000000q1');
    await updateAgent(env.DB, t, 'agt_chotu', {
      ownerUserId: 'usr_rakesh',
      mayQueueTo: [boardId],
    });

    await withIssuer(t, async () => {
      const token = await agentToken('prn_chotu0000000000q1', ['prn_kai', 'prn_tim']);
      const { status, body } = await queue(boardId, token, 'Shape the release');
      expect(status).toBe(201);
      const card = (body as unknown as { card: Record<string, unknown> }).card;

      // The whole safety model, in one assertion: an agent may queue work only for principals it
      // may itself dispatch. Not the operator's 55-principal grant — the agent's own two.
      expect(card.queuedGrant).toEqual(['prn_kai', 'prn_tim']);
      // Answerable: the human. Authorised by: the agent's principal. Two different questions.
      expect(card.ownerUserId).toBe('usr_rakesh');
      expect(card.queuedBy).toBe('prn_chotu0000000000q1');
      // And distinguishable from a human-queued card forever, in the row.
      expect(card.queuedByAgentId).toBe('agt_chotu');
    });
  });

  it('NEVER owns a card to the string `usr_dev`', async () => {
    // What the route did before this work: `ownerUserId: body.ownerUserId ?? user?.userId ?? 'usr_dev'`.
    // On an agent path `user` is undefined, so real work would have been owned by a literal that
    // names no user in any workspace — and carried a null grant, making it unclaimable under
    // enforcement. A card nobody can claim looks queued and is dead.
    const t = 'tnt_q2';
    const boardId = await board(t);
    await agentRow(t, 'agt_noowner', 'prn_noowner000000000q2');
    await updateAgent(env.DB, t, 'agt_noowner', { mayQueueTo: [boardId] });

    await withIssuer(t, async () => {
      const token = await agentToken('prn_noowner000000000q2', ['prn_kai']);
      const { status, body } = await queue(boardId, token, 'Orphan');
      expect(status).toBe(403);
      expect((body as unknown as { error: { code: string } }).error.code).toBe('AGENT_HAS_NO_OWNER');
    });
  });

  it('refuses an agent whose grant is EMPTY, by name, instead of making a dead card', async () => {
    const t = 'tnt_q3';
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, name) VALUES ('usr_r3','r3@example.test','R')`).run();
    const boardId = await board(t);
    await agentRow(t, 'agt_ungranted', 'prn_ungranted00000q3');
    await updateAgent(env.DB, t, 'agt_ungranted', { ownerUserId: 'usr_r3', mayQueueTo: [boardId] });

    await withIssuer(t, async () => {
      // An issuer that speaks the claim and grants nothing. That is a decision, and the decision
      // is no — so the refusal is at creation, where it can be read, not at claim time on a card
      // that already exists and looks fine.
      const token = await agentToken('prn_ungranted00000q3', []);
      const { status, body } = await queue(boardId, token, 'Nothing can run this');
      expect(status).toBe(403);
      expect((body as unknown as { error: { code: string } }).error.code).toBe('NO_DISPATCH_AUTHORITY');
    });
  });

  it('refuses a board the operator did not name, and null means NO board', async () => {
    const t = 'tnt_q4';
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, name) VALUES ('usr_r4','r4@example.test','R')`).run();
    const allowed = await board(t, 'Allowed');
    const forbidden = await board(t, 'Forbidden');
    await agentRow(t, 'agt_bounded', 'prn_bounded000000000q4');

    await withIssuer(t, async () => {
      const token = await agentToken('prn_bounded000000000q4', ['prn_kai']);

      // Unset. The design doc proposed defaulting to "rostered boards"; this plane has no roster,
      // so the default is the fail-closed half of what that section required.
      await updateAgent(env.DB, t, 'agt_bounded', { ownerUserId: 'usr_r4', mayQueueTo: null });
      expect((await queue(allowed, token, 'Unset')).status).toBe(403);

      await updateAgent(env.DB, t, 'agt_bounded', { mayQueueTo: [allowed] });
      expect((await queue(allowed, token, 'Named')).status).toBe(201);
      const refused = await queue(forbidden, token, 'Not named');
      expect(refused.status).toBe(403);
      expect((refused.body as unknown as { error: { code: string } }).error.code).toBe('BOARD_NOT_PERMITTED');
    });
  });

  it('stops at the hourly ceiling, because a scope bounds whether and not how much', async () => {
    const t = 'tnt_q5';
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, name) VALUES ('usr_r5','r5@example.test','R')`).run();
    const boardId = await board(t);
    await agentRow(t, 'agt_eager', 'prn_eager00000000000q5');
    await updateAgent(env.DB, t, 'agt_eager', {
      ownerUserId: 'usr_r5',
      mayQueueTo: [boardId],
      queueCeilingPerHour: 2,
    });

    await withIssuer(t, async () => {
      const token = await agentToken('prn_eager00000000000q5', ['prn_kai']);
      expect((await queue(boardId, token, 'One')).status).toBe(201);
      expect((await queue(boardId, token, 'Two')).status).toBe(201);
      const third = await queue(boardId, token, 'Three');
      expect(third.status).toBe(429);
      expect((third.body as unknown as { error: { code: string } }).error.code).toBe('QUEUE_CEILING_REACHED');
    });
  });

  it('refuses a credential that cannot SPEAK to the grant, distinctly from one that grants nothing', async () => {
    // An issuer that does not send the claim at all. Absent is not empty — the hub's own contract
    // says so — and conflating them would either invent authority or report a decision nobody made.
    const t = 'tnt_q6';
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, name) VALUES ('usr_r6','r6@example.test','R')`).run();
    const boardId = await board(t);
    await agentRow(t, 'agt_silent', 'prn_silent0000000000q6');
    await updateAgent(env.DB, t, 'agt_silent', { ownerUserId: 'usr_r6', mayQueueTo: [boardId] });

    await withIssuer(t, async () => {
      const token = await agentToken('prn_silent0000000000q6');
      const { status, body } = await queue(boardId, token, 'From a silent issuer');
      expect(status).toBe(403);
      expect((body as unknown as { error: { code: string } }).error.code).toBe('DISPATCH_GRANT_UNKNOWN');
    });
  });
});

describe('what a coordinator may read', () => {
  it('lists the workspace\'s boards on `read`, which is the whole point of the scope', async () => {
    const t = 'tnt_q7';
    const boardId = await board(t, 'Visible');
    await agentRow(t, 'agt_reader', 'prn_reader0000000000q7');

    await withIssuer(t, async () => {
      const token = await agentToken('prn_reader0000000000q7', []);
      const res = await SELF.fetch(`${PLANE}/v1/boards`, { headers: auth(token) });
      expect(res.status).toBe(200);
      const { boards } = await res.json<{ boards: Array<{ id: string }> }>();
      expect(boards.map((b) => b.id)).toContain(boardId);

      // And one board in full, which is what "see who is free and what is stuck" needs.
      expect((await SELF.fetch(`${PLANE}/v1/boards/${boardId}`, { headers: auth(token) })).status).toBe(200);
    });
  });

  it('cannot restructure what it can read', async () => {
    // The blast radius, asserted rather than described. Stages, deletion and gate decisions stay
    // human-only; a coordinator needs to see the board and add to it, never to rework it.
    const t = 'tnt_q8';
    const boardId = await board(t, 'Read only');
    await agentRow(t, 'agt_meddler', 'prn_meddler000000000q8');

    await withIssuer(t, async () => {
      const token = await agentToken('prn_meddler000000000q8', ['prn_kai']);
      for (const method of ['PATCH', 'DELETE']) {
        const res = await SELF.fetch(`${PLANE}/v1/boards/${boardId}`, { method, headers: auth(token) });
        // 401, not 403, and the difference says which layer refused. The agent door is scoped by
        // METHOD, so an edit never enters the agent branch at all; it falls to the human branch,
        // which finds no human behind an agent token. `requiredScope`'s `__forbidden__` verdict is
        // the second line behind this one — unreachable while the door is method-scoped, and
        // exactly what catches it if somebody later widens the door to a path-only test. Which is
        // the mistake that was actually made once in writing this change.
        expect(res.status).toBe(401);
      }
      const stages = await SELF.fetch(`${PLANE}/v1/boards/${boardId}/stages`, {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ stages: PIPELINE }),
      });
      // Not an agent route at all — it falls to the human branch, which has no person to resolve.
      expect(stages.status).toBe(401);
    });
  });
});

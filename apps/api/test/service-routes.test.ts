/**
 * A service (Superlibrary) reading boards and cards and registering a record push config.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';
import { boardStub } from '../src/board/stub';
import type { BoardInit } from '../src/board/board-do';
import { recordBoard } from '../src/db/catalog';
import { newId } from '../src/ids';
import { ensureOrgTenant } from '../src/auth/org-tenancy';
import { withIssuer } from './helpers/hub-issuer';
import { withOrgPlane, planeToken, ORG, OTHER_ORG, SERVICE, AGENT } from './helpers/org-plane';

const PIPELINE: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
];
const ISSUER = 'https://issuer-svc.test';
const PLANE = 'https://api.test';
const FLEET = 'fleet_0000000000000000sv01';
const OTHER_FLEET = 'fleet_0000000000000000sv02';
const TENANT = 'tnt_service_routes';
const OTHER_TENANT = 'tnt_service_routes_other';

let signingKey: CryptoKey;
let jwksBody: string;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'sv-kid' }] });
  for (const [t, f] of [[TENANT, FLEET], [OTHER_TENANT, OTHER_FLEET]] as const) {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'S')`).bind(t, `slug-${t}`).run();
    await env.DB.prepare(`UPDATE tenants SET external_source='agentpod', external_id=? WHERE id=?`).bind(f, t).run();
  }
});
beforeEach(() => __resetJwksCacheForTests());

const hubToken = (over: Record<string, unknown> = {}) =>
  new SignJWT({ sub: 'prn_0123456789abcdef0f01', principalKind: 'service', tenant: FLEET, mayDispatch: [], mayGrantReach: false, scope: 'cards:read', ...over })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'sv-kid' })
    .setIssuedAt().setIssuer(ISSUER).setAudience([ISSUER, PLANE]).setExpirationTime('5m')
    .sign(signingKey);

const legacy = <T>(fn: () => Promise<T>) => withIssuer(ISSUER, jwksBody, fn);
const get = (path: string, token: string) => SELF.fetch(`https://api.test${path}`, { headers: { Authorization: `Bearer ${token}` } });
const post = (path: string, token: string, body: unknown) =>
  SELF.fetch(`https://api.test${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

/** A board in `tenant` with one card whose review gate was opened and approved. */
async function seedBoardWithResolvedGate(o: { archive?: boolean; tenant?: string } = {}): Promise<{ boardId: string; cardId: string }> {
  const tenant = o.tenant ?? TENANT;
  const boardId = newId('brd');
  const board = boardStub(env, tenant, boardId);
  await board.init({ id: boardId, tenantId: tenant, name: 'Svc board', stages: PIPELINE });
  await recordBoard(env.DB, tenant, { id: boardId, name: 'Svc board', stagesJson: JSON.stringify(PIPELINE) });
  const card = await board.createCard({ title: 'Add OAuth login', ownerUserId: 'usr_a' });
  if (!card.ok) throw new Error(card.message);
  const claim = await board.claim({ agentId: 'agt_r', capabilities: ['research'] });
  if (!claim.claimed) throw new Error('expected a research claim');
  await board.complete({ runId: claim.runId, leaseEpoch: claim.leaseEpoch, handoff: { summary: 'drafted' } });
  const pending = (await board.getState()).gates[0];
  if (!pending) throw new Error('expected a pending gate');
  const resolved = await board.resolveGate({ gateId: pending.id, decision: 'approve', decidedBy: 'usr_a' });
  if (!resolved.ok) throw new Error(resolved.message);
  if (o.archive) await board.updateCard(card.value.id, { archivedAt: new Date().toISOString() });
  return { boardId, cardId: card.value.id };
}

describe('a service reading cards (hub issuer)', () => {
  it('lists boards and reads a board, a card, its attempts, comments, links and gates with cards:read', async () => {
    await legacy(async () => {
      const { boardId, cardId } = await seedBoardWithResolvedGate();
      const t = await hubToken();
      const base = `/v1/boards/${boardId}/cards/${cardId}`;
      for (const path of ['/v1/boards', `/v1/boards/${boardId}`, base, `${base}/attempts`, `${base}/comments`, `${base}/links`, `${base}/activities`]) {
        expect((await get(path, t)).status, path).toBe(200);
      }
      const boards = (await (await get('/v1/boards', t)).json()) as { boards: Array<{ id: string }> };
      expect(boards.boards.map((b) => b.id)).toContain(boardId);
      const links = (await (await get(`${base}/links`, t)).json()) as Record<string, unknown>;
      expect(Object.keys(links).sort()).toEqual(['externalLinks', 'links']);
      const act = (await (await get(`${base}/activities`, t)).json()) as { gates: Array<{ status: string; decision: string }> };
      expect(act.gates).toContainEqual(expect.objectContaining({ status: 'resolved', decision: 'approve' }));
    });
  });

  it('the snapshot includes archived cards', async () => {
    await legacy(async () => {
      const { boardId, cardId } = await seedBoardWithResolvedGate({ archive: true });
      const r = await get(`/v1/boards/${boardId}`, await hubToken());
      const body = (await r.json()) as { cards: Array<{ id: string; archivedAt: string | null }> };
      expect(body.cards).toContainEqual(expect.objectContaining({ id: cardId, archivedAt: expect.any(String) }));
    });
  });

  it('without the scope it is refused', async () => {
    await legacy(async () => {
      const { boardId } = await seedBoardWithResolvedGate();
      expect((await get(`/v1/boards/${boardId}`, await hubToken({ scope: '' }))).status).toBe(403);
      expect((await get(`/v1/boards/${boardId}`, await hubToken({ scope: 'push:write' }))).status).toBe(403);
      expect((await get('/v1/boards', await hubToken({ scope: 'evidence:read' }))).status).toBe(403);
    });
  });

  it('an agent token is refused (it is not a service route)', async () => {
    await legacy(async () => {
      const { boardId } = await seedBoardWithResolvedGate();
      const agentToken = await hubToken({ principalKind: 'agent' });
      const r = await get(`/v1/boards/${boardId}`, agentToken);
      expect([401, 403]).toContain(r.status);
      expect(await r.text()).not.toContain('Svc board');
    });
  });

  it('a missing board is not found, as it is for a person', async () => {
    await legacy(async () => {
      const r = await get('/v1/boards/brd_00000000000000ff', await hubToken());
      expect(r.status).toBe(404);
      expect((await get('/v1/boards/brd_00000000000000ff/cards/card_00000000000000ff/links', await hubToken())).status).toBe(404);
    });
  });

  it('a board in another tenant is not found, whatever the route', async () => {
    await legacy(async () => {
      const { boardId, cardId } = await seedBoardWithResolvedGate({ tenant: OTHER_TENANT });
      const t = await hubToken();
      const base = `/v1/boards/${boardId}`;
      for (const path of [base, `${base}/cards/${cardId}`, `${base}/cards/${cardId}/attempts`, `${base}/cards/${cardId}/comments`, `${base}/cards/${cardId}/links`, `${base}/cards/${cardId}/activities`]) {
        expect((await get(path, t)).status, path).toBe(404);
      }
      const boards = (await (await get('/v1/boards', t)).json()) as { boards: Array<{ id: string }> };
      expect(boards.boards.map((b) => b.id)).not.toContain(boardId);
      const pushed = await post(`${base}/push-configs`, await hubToken({ scope: 'push:write' }), {
        url: 'https://library.example.com/events', token: 'd', events: ['card.updated'],
      });
      expect(pushed.status).toBe(404);
    });
  });
});

describe('a service registering a push config (hub issuer)', () => {
  it('registers a record-event config with push:write, under svc:<prn>', async () => {
    await legacy(async () => {
      const { boardId } = await seedBoardWithResolvedGate();
      const t = await hubToken({ scope: 'push:write' });
      const r = await post(`/v1/boards/${boardId}/push-configs`, t, {
        url: `https://library.example.com/api/v1/sources/superpipeline/events?board=${boardId}`, token: 'derived', events: ['card.updated'],
      });
      expect(r.status).toBe(201);
      // Stored under the service's principal: the same call again answers the same config (agent_id + url).
      const again = await post(`/v1/boards/${boardId}/push-configs`, t, {
        url: `https://library.example.com/api/v1/sources/superpipeline/events?board=${boardId}`, token: 'derived', events: ['card.updated'],
      });
      expect(((await again.json()) as { configId: string }).configId).toBe(((await r.json()) as { configId: string }).configId);
      const agentIds = await runInDurableObject(
        env.BOARD_DO.get(env.BOARD_DO.idFromName(`${TENANT}:${boardId}`)),
        async (_i, state) => state.storage.sql.exec(`SELECT agent_id FROM push_configs`).toArray().map((r) => r.agent_id),
      );
      expect(agentIds).toEqual(['svc:prn_0123456789abcdef0f01']);
    });
  });

  it('refuses events that are not record events, and a body without a token', async () => {
    await legacy(async () => {
      const { boardId } = await seedBoardWithResolvedGate();
      const t = await hubToken({ scope: 'push:write' });
      const p = `/v1/boards/${boardId}/push-configs`;
      const known = await post(p, t, { url: 'https://library.example.com/x', token: 'd', events: ['work.available'] });
      expect(known.status).toBe(400);
      expect(((await known.json()) as { error: { code: string } }).error.code).toBe('INVALID_BODY');
      const unknown = await post(p, t, { url: 'https://library.example.com/x', token: 'd', events: ['card.nonsense'] });
      expect(unknown.status).toBe(400);
      expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('UNKNOWN_EVENT');
      expect((await post(p, t, { url: 'https://library.example.com/x', token: 'd', events: [] })).status).toBe(400);
      expect((await post(p, t, { url: 'https://library.example.com/x', events: ['card.updated'] })).status).toBe(400);
    });
  });

  it('needs push:write, not cards:read', async () => {
    await legacy(async () => {
      const { boardId } = await seedBoardWithResolvedGate();
      const r = await post(`/v1/boards/${boardId}/push-configs`, await hubToken({ scope: 'cards:read' }), {
        url: 'https://library.example.com/x', token: 'd', events: ['card.updated'],
      });
      expect(r.status).toBe(403);
    });
  });
});

describe('the same routes in Organization-plane mode (the production path)', () => {
  const svcToken = (over: Record<string, unknown> = {}) =>
    planeToken({ sub: SERVICE, principalKind: 'service', scope: 'cards:read push:write', email: undefined, email_verified: undefined, ...over });

  it('a service token with the superpipeline entitlement reads its own org board and pushes', async () => {
    await withOrgPlane(async () => {
      const tenant = await ensureOrgTenant(env.DB, ORG);
      const { boardId, cardId } = await seedBoardWithResolvedGate({ tenant });
      const t = await svcToken();
      expect((await get(`/v1/boards/${boardId}/cards/${cardId}`, t)).status).toBe(200);
      const reg = await post(`/v1/boards/${boardId}/push-configs`, t, { url: 'https://library.example.com/e', token: 'd', events: ['card.updated'] });
      expect(reg.status).toBe(201);
    });
  });

  it('refuses without the entitlement, for an agent, for a human, and for another org', async () => {
    await withOrgPlane(async () => {
      const tenant = await ensureOrgTenant(env.DB, ORG);
      const other = await ensureOrgTenant(env.DB, OTHER_ORG);
      const { boardId } = await seedBoardWithResolvedGate({ tenant });
      const path = `/v1/boards/${boardId}`;
      expect([401, 403]).toContain((await get(path, await svcToken({ ent: [] }))).status);
      expect([401, 403]).toContain((await get(path, await svcToken({ principalKind: 'agent', sub: AGENT }))).status);
      expect([401, 403]).toContain((await get(path, await svcToken({ principalKind: 'human' }))).status);
      expect((await get(path, await svcToken({ scope: '' }))).status).toBe(403);
      // Another org's service cannot see this org's board.
      expect(other).not.toBe(tenant);
      expect((await get(path, await svcToken({ org: OTHER_ORG }))).status).toBe(404);
    });
  });
});

describe('a bearer that is not a service stays on the existing routes', () => {
  it('a person with a plane bearer reads the board as before (200), not as a service', async () => {
    await withOrgPlane(async () => {
      const tenant = await ensureOrgTenant(env.DB, ORG);
      const { boardId, cardId } = await seedBoardWithResolvedGate({ tenant });
      const human = await planeToken();
      expect((await get(`/v1/boards/${boardId}`, human)).status).toBe(200);
      expect((await get(`/v1/boards/${boardId}/cards/${cardId}`, human)).status).toBe(200);
    });
  });
});

describe('a person cannot name a service as the subscriber', () => {
  it('refuses X-Agent-Id svc:<prn> on the human push-config route and leaves the service config alone', async () => {
    await legacy(async () => {
      const { boardId } = await seedBoardWithResolvedGate();
      const url = 'https://library.example.com/own';
      const svc = await post(`/v1/boards/${boardId}/push-configs`, await hubToken({ scope: 'push:write' }), { url, token: 'service-token', events: ['card.updated'] });
      expect(svc.status).toBe(201);
      const r = await SELF.fetch(`https://api.test/v1/boards/${boardId}/push-configs`, {
        method: 'POST',
        headers: { 'X-Tenant-Id': TENANT, 'X-User-Id': 'usr_owner', 'X-Agent-Id': 'svc:prn_0123456789abcdef0f01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, token: 'attacker-token', events: ['card.updated'] }),
      });
      expect(r.status).toBe(400);
      const tokens = await runInDurableObject(
        env.BOARD_DO.get(env.BOARD_DO.idFromName(`${TENANT}:${boardId}`)),
        async (_i, state) => state.storage.sql.exec(`SELECT token FROM push_configs WHERE agent_id LIKE 'svc:%'`).toArray().map((x) => x.token),
      );
      expect(tokens).toEqual(['service-token']);
    });
  });
});

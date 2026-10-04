/**
 * The per-board queue-list: which SERVICE principals (`prn_…`) a board accepts cards from.
 *
 * This file covers the list and its management route only. Card creation does not consult it yet;
 * that is a later change, which reads one entry through `BoardDO.getQueuer`.
 *
 * Managing the list is a HUMAN act at the same role as every other board setting (`manage`, i.e.
 * admin). Reading it is `read`. No agent or service credential reaches either.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';
import type { BoardDO } from '../src/board/board-do';
import { withIssuer } from './helpers/hub-issuer';

const TENANT = 'tnt_queuers';
const FLEET = 'fleet_0000000000000000qu01';
const ISSUER = 'https://issuer-queuers.test';
const PLANE = 'https://api.test';
const PIPE = [{ key: 'todo', name: 'To do', order: 0 }];
const PRN = 'prn_45e839063d7b4a588152';
const PRN2 = 'prn_0123456789abcdef0123';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const as = (user: string) => ({ 'X-Tenant-Id': TENANT, 'X-User-Id': user, 'Content-Type': 'application/json' });
const ADMIN = as('usr_q_admin');
const MEMBER = as('usr_q_member');
const VIEWER = as('usr_q_viewer');

let signingKey: CryptoKey;
let jwksBody: string;

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'Q')`).bind(TENANT, `slug-${TENANT}`).run();
  await env.DB.prepare(`UPDATE tenants SET external_source='agentpod', external_id=? WHERE id=?`).bind(FLEET, TENANT).run();
  for (const [user, role] of [['usr_q_admin', 'admin'], ['usr_q_member', 'member'], ['usr_q_viewer', 'viewer']] as const) {
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`).bind(user, `${user}@test.dev`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, ?)`)
      .bind(`mbr_${user}`, TENANT, user, role)
      .run();
  }
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'qu-kid' }] });
});
beforeEach(() => __resetJwksCacheForTests());

async function board(): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'Q', stages: PIPE }) });
  expect(res.status).toBe(201);
  return (await res.json<{ boardId: string }>()).boardId;
}

const url = (boardId: string, suffix = '') => `https://api.test/v1/boards/${boardId}/queuers${suffix}`;
const add = (boardId: string, headers: Record<string, string>, principalId: unknown) =>
  SELF.fetch(url(boardId), { method: 'POST', headers, body: JSON.stringify({ principalId }) });
const list = (boardId: string, headers: Record<string, string>) => SELF.fetch(url(boardId), { headers });
const remove = (boardId: string, headers: Record<string, string>, principalId: string) =>
  SELF.fetch(url(boardId, `/${principalId}`), { method: 'DELETE', headers });

type Queuer = { principalId: string; addedBy: string; addedAt: string };

describe('/v1/boards/:id/queuers', () => {
  it('an admin adds, lists and removes a queuer', async () => {
    const b = await board();

    const empty = await list(b, ADMIN);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ queuers: [] });

    const added = await add(b, ADMIN, PRN);
    expect(added.status).toBe(201);
    const entry = await added.json<Queuer>();
    expect(entry).toEqual({ principalId: PRN, addedBy: 'usr_q_admin', addedAt: expect.stringMatching(ISO) });

    const listed = await list(b, ADMIN);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ queuers: [entry] });

    const removed = await remove(b, ADMIN, PRN);
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
    expect(await (await list(b, ADMIN)).json()).toEqual({ queuers: [] });
  });

  it('adding an id already on the list is 200 with the existing entry, unchanged', async () => {
    const b = await board();
    const first = await (await add(b, ADMIN, PRN)).json<Queuer>();
    // Promoted to admin for this one call so a DIFFERENT human re-adds it: the entry must still
    // name whoever added it first.
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES ('usr_q_admin2', 'a2@test.dev')`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO memberships (id, tenant_id, user_id, role) VALUES ('mbr_q_admin2', ?, 'usr_q_admin2', 'admin')`)
      .bind(TENANT)
      .run();
    const again = await add(b, as('usr_q_admin2'), PRN);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(await (await list(b, ADMIN)).json()).toEqual({ queuers: [first] });
  });

  it('removing an id not on the list is 404 QUEUER_NOT_FOUND', async () => {
    const b = await board();
    const res = await remove(b, ADMIN, PRN2);
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('QUEUER_NOT_FOUND');
  });

  it('a malformed principal id is 400 INVALID_PRINCIPAL_ID, on add and on remove', async () => {
    const b = await board();
    for (const bad of ['prn_45E839063D7B4A588152', 'prn_45e8', 'usr_q_admin', '', 42, null, 'prn_45e839063d7b4a5881520']) {
      const res = await add(b, ADMIN, bad);
      expect(res.status, String(bad)).toBe(400);
      expect((await res.json<{ error: { code: string } }>()).error.code).toBe('INVALID_PRINCIPAL_ID');
    }
    const noBody = await SELF.fetch(url(b), { method: 'POST', headers: ADMIN, body: 'not json' });
    expect(noBody.status).toBe(400);
    expect((await noBody.json<{ error: { code: string } }>()).error.code).toBe('INVALID_PRINCIPAL_ID');

    const del = await remove(b, ADMIN, 'prn_nothex');
    expect(del.status).toBe(400);
    expect((await del.json<{ error: { code: string } }>()).error.code).toBe('INVALID_PRINCIPAL_ID');
    expect(await (await list(b, ADMIN)).json()).toEqual({ queuers: [] });
  });

  it('a member may not add or remove (403)', async () => {
    const b = await board();
    expect((await add(b, MEMBER, PRN)).status).toBe(403);
    await add(b, ADMIN, PRN);
    expect((await remove(b, MEMBER, PRN)).status).toBe(403);
    expect((await (await list(b, ADMIN)).json<{ queuers: Queuer[] }>()).queuers).toHaveLength(1);
  });

  it('a viewer may list but not add or remove', async () => {
    const b = await board();
    await add(b, ADMIN, PRN);
    const listed = await list(b, VIEWER);
    expect(listed.status).toBe(200);
    expect((await listed.json<{ queuers: Queuer[] }>()).queuers.map((q) => q.principalId)).toEqual([PRN]);
    expect((await add(b, VIEWER, PRN2)).status).toBe(403);
    expect((await remove(b, VIEWER, PRN)).status).toBe(403);
  });

  it('an agent token is refused on every method', async () => {
    const b = await board();
    await add(b, ADMIN, PRN);
    const made = await SELF.fetch('https://api.test/v1/agents', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'qa', capabilities: ['todo'] }) });
    const { token } = await made.json<{ token: string }>();
    expect(token).toMatch(/^spa_/);
    const bearer = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await list(b, bearer)).status).toBe(401);
    expect((await add(b, bearer, PRN2)).status).toBe(401);
    expect((await remove(b, bearer, PRN)).status).toBe(401);
    expect((await (await list(b, ADMIN)).json<{ queuers: Queuer[] }>()).queuers.map((q) => q.principalId)).toEqual([PRN]);
  });

  it('a service token is refused on every method, even one carrying cards:queue', async () => {
    const b = await board();
    await add(b, ADMIN, PRN);
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await new SignJWT({
        sub: PRN,
        principalKind: 'service',
        tenant: FLEET,
        mayDispatch: [],
        mayGrantReach: false,
        scope: 'evidence:read cards:queue',
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'qu-kid' })
        .setIssuedAt().setIssuer(ISSUER).setAudience([ISSUER, PLANE]).setExpirationTime('5m')
        .sign(signingKey);
      const bearer = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      expect((await list(b, bearer)).status).toBe(401);
      expect((await add(b, bearer, PRN2)).status).toBe(401);
      expect((await remove(b, bearer, PRN)).status).toBe(401);
    });
    expect((await (await list(b, ADMIN)).json<{ queuers: Queuer[] }>()).queuers.map((q) => q.principalId)).toEqual([PRN]);
  });

  it('each add and remove writes a board activity entry naming the human and the principal', async () => {
    const b = await board();
    await add(b, ADMIN, PRN);
    await add(b, ADMIN, PRN); // idempotent re-add: nothing happened, so nothing is logged
    await remove(b, ADMIN, PRN);
    const { events } = await (await SELF.fetch(`https://api.test/v1/boards/${b}/events`, { headers: ADMIN })).json<{
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    }>();
    const q = events.filter((e) => e.type.startsWith('queuer.'));
    expect(q).toEqual([
      expect.objectContaining({ type: 'queuer.added', payload: { principalId: PRN, addedBy: 'usr_q_admin' } }),
      expect.objectContaining({ type: 'queuer.removed', payload: { principalId: PRN, removedBy: 'usr_q_admin' } }),
    ]);
  });

  it('an unknown board is 404 on every method', async () => {
    const missing = 'brd_0000000000000000';
    expect((await list(missing, ADMIN)).status).toBe(404);
    expect((await add(missing, ADMIN, PRN)).status).toBe(404);
    expect((await remove(missing, ADMIN, PRN)).status).toBe(404);
  });
});

describe('BoardDO.getQueuer — the lookup card creation will use', () => {
  it('returns the entry for a listed principal and null for anyone else', async () => {
    const b = await board();
    await add(b, ADMIN, PRN);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`${TENANT}:${b}`)) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (doi: BoardDO) => {
      expect(await doi.getQueuer(PRN)).toEqual({ principalId: PRN, addedBy: 'usr_q_admin', addedAt: expect.stringMatching(ISO) });
      expect(await doi.getQueuer(PRN2)).toBeNull();
      expect(await doi.getQueuer('not-an-id')).toBeNull();
    });
    await remove(b, ADMIN, PRN);
    await runInDurableObject(stub, async (doi: BoardDO) => {
      expect(await doi.getQueuer(PRN)).toBeNull();
    });
  });
});

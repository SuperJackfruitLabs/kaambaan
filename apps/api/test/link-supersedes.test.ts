import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BoardDO, BoardInit } from '../src/board/board-do';

const BUILD: BoardInit['stages'] = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];
const stubFor = (n: string) => env.BOARD_DO.get(env.BOARD_DO.idFromName(n)) as unknown as DurableObjectStub<BoardDO>;
const idOf = (r: unknown) => (r as { ok: true; value: { id: string } }).value.id;

describe('supersedes (Durable Object)', () => {
  it('links a newer card to the one it replaces, and both ends see it', async () => {
    await runInDurableObject(stubFor('sup-1'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000c1', tenantId: 'tnt_a', name: 'S', stages: BUILD });
      const old = idOf(await board.createCard({ title: 'v1', ownerUserId: 'usr_a' }));
      const next = idOf(await board.createCard({ title: 'v2', ownerUserId: 'usr_a' }));
      const r = await board.addLink({ fromCardId: next, toCardId: old, kind: 'supersedes' });
      expect(r.ok).toBe(true);
      expect(await board.listLinks(old)).toContainEqual(expect.objectContaining({ fromCardId: next, toCardId: old, kind: 'supersedes' }));
      expect(await board.listLinks(next)).toContainEqual(expect.objectContaining({ fromCardId: next, toCardId: old, kind: 'supersedes' }));
    });
  });

  it('does not block the superseded card, nor check cycles', async () => {
    await runInDurableObject(stubFor('sup-2'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000c2', tenantId: 'tnt_a', name: 'S', stages: BUILD });
      const old = idOf(await board.createCard({ title: 'v1', ownerUserId: 'usr_a' }));
      const next = idOf(await board.createCard({ title: 'v2', ownerUserId: 'usr_a' }));
      await board.addLink({ fromCardId: next, toCardId: old, kind: 'supersedes' });
      // Not an ordering link: the reverse edge is not a cycle.
      expect((await board.addLink({ fromCardId: old, toCardId: next, kind: 'supersedes' })).ok).toBe(true);
      for (const id of [old, next]) {
        const v = await board.getCardView(id);
        expect((v as { ok: true; value: { blockedBy: unknown[] } }).value.blockedBy).toEqual([]);
      }
    });
  });

  it('pushes link.added and link.removed to a record subscriber', async () => {
    await runInDurableObject(stubFor('sup-3'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000c3', tenantId: 'tnt_a', name: 'S', stages: BUILD });
      await board.registerPushConfig({ agentId: 'svc:prn_000000000000000000a2', url: 'https://hook.test/x', token: 's', events: ['link.added', 'link.removed'] });
      const old = idOf(await board.createCard({ title: 'v1', ownerUserId: 'usr_a' }));
      const next = idOf(await board.createCard({ title: 'v2', ownerUserId: 'usr_a' }));
      await board.addLink({ fromCardId: next, toCardId: old, kind: 'supersedes' });
      await board.removeLink(next, old, 'supersedes');
      const bodies = (await board.getPushDeliveries()).map((d) => JSON.parse(d.body));
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toMatchObject({ event: 'link.added', cardIds: [next, old] });
      expect(bodies[1]).toMatchObject({ event: 'link.removed', cardIds: [next, old] });
    });
  });
});

describe('supersedes (REST)', () => {
  const T = { 'X-Tenant-Id': 'tnt_sup_rest', 'Content-Type': 'application/json' };
  const base = 'https://api.test';
  beforeAll(async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_sup_rest', 'sup-rest', 'Sup Rest')`).run();
  });
  async function board(name: string) {
    const r = await SELF.fetch(`${base}/v1/boards`, { method: 'POST', headers: T, body: JSON.stringify({ name, stages: BUILD }) });
    return ((await r.json()) as { boardId: string }).boardId;
  }
  async function card(b: string, title: string) {
    const r = await SELF.fetch(`${base}/v1/boards/${b}/cards`, { method: 'POST', headers: T, body: JSON.stringify({ title, ownerUserId: 'usr_o' }) });
    return ((await r.json()) as { card: { id: string } }).card.id;
  }

  it('accepts a same-board supersedes and reports it as not enforced', async () => {
    const b = await board('A');
    const old = await card(b, 'v1');
    const next = await card(b, 'v2');
    const res = await SELF.fetch(`${base}/v1/boards/${b}/links`, { method: 'POST', headers: T, body: JSON.stringify({ fromCardId: next, toCardId: old, kind: 'supersedes' }) });
    expect(res.status).toBe(201);
    const list = (await (await SELF.fetch(`${base}/v1/boards/${b}/cards/${old}/links`, { headers: T })).json()) as { links: { kind: string; enforced: boolean }[] };
    expect(list.links).toContainEqual(expect.objectContaining({ kind: 'supersedes', enforced: false }));
  });

  it('refuses a cross-board supersedes with 400 INVALID_LINK_KIND', async () => {
    const home = await board('Home');
    const away = await board('Away');
    const a = await card(home, 'A');
    const c = await card(away, 'C');
    const res = await SELF.fetch(`${base}/v1/boards/${home}/links`, { method: 'POST', headers: T, body: JSON.stringify({ fromCardId: a, toCardId: c, toBoardId: away, kind: 'supersedes' }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_LINK_KIND');
  });

  it('refuses a cross-board supersedes DELETE the same way', async () => {
    const home = await board('Home2');
    const away = await board('Away2');
    const a = await card(home, 'A');
    const c = await card(away, 'C');
    const res = await SELF.fetch(`${base}/v1/boards/${home}/links`, { method: 'DELETE', headers: T, body: JSON.stringify({ fromCardId: a, toCardId: c, toBoardId: away, kind: 'supersedes' }) });
    expect(res.status).toBe(400);
  });
});

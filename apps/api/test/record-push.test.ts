import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BoardDO, BoardInit } from '../src/board/board-do';
import { RECORD_EVENTS, cardIdsOf } from '../src/push/events';

const BUILD: BoardInit['stages'] = [
  { key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' },
  { key: 'ship', name: 'Ship', order: 1, ownerKind: 'capability', owner: 'ship' },
];
const HOOK = 'https://library.example.com/api/v1/sources/superpipeline/events';
const SVC = 'svc:prn_0000000000000000c0b3';
const stubFor = (name: string) => env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
const idOf = (r: unknown) => (r as { ok: true; value: { id: string } }).value.id;

describe('record events reach push configs (Superlibrary spec §5)', () => {
  it('lists every event Superlibrary subscribes to', () => {
    expect([...RECORD_EVENTS].sort()).toEqual([
      'card.advanced', 'card.blocked', 'card.comment.added', 'card.comment.deleted', 'card.completed', 'card.created',
      'card.deleted', 'card.failed', 'card.moved', 'card.rejected', 'card.resumed', 'card.updated', 'gate.resolved',
      'link.added', 'link.removed',
    ]);
  });

  it('queues one signed delivery per subscribed event, naming the card and nothing of its content', async () => {
    await runInDurableObject(stubFor('rec-1'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000b1', tenantId: 'tnt_a', name: 'R', stages: BUILD });
      const reg = await board.registerPushConfig({ agentId: SVC, url: HOOK, token: 's3cret', events: [...RECORD_EVENTS] });
      expect(reg.ok).toBe(true);
      const cardId = idOf(await board.createCard({ title: 'Secret plan', ownerUserId: 'usr_a' }));
      await board.updateCard(cardId, { title: 'Secret plan v2' });
      const bodies = (await board.getPushDeliveries()).map((d) => JSON.parse(d.body));
      expect(bodies.map((b) => b.event)).toEqual(['card.created', 'card.updated']);
      expect(bodies[0]).toEqual({ event: 'card.created', boardId: 'brd_00000000000000b1', seq: expect.any(Number), ts: expect.any(String), cardIds: [cardId] });
      expect(JSON.stringify(bodies)).not.toContain('Secret plan');
    });
  });

  it('drains record deliveries signed, with the event header', async () => {
    await runInDurableObject(stubFor('rec-5'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000b5', tenantId: 'tnt_a', name: 'R', stages: BUILD });
      await board.registerPushConfig({ agentId: SVC, url: HOOK, token: 's3cret', events: ['card.created'] });
      await board.createCard({ title: 'x', ownerUserId: 'usr_a' });
      const seen: Array<{ url: string; headers: Record<string, string> }> = [];
      const out = await board.dispatchPushDeliveries(async (url, init) => {
        seen.push({ url, headers: init.headers });
        return { status: 200 };
      });
      expect(out).toEqual({ sent: 1, failed: 0 });
      expect(seen[0]!.url).toBe(HOOK);
      expect(seen[0]!.headers['X-Superpipeline-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(seen[0]!.headers['X-Superpipeline-Event']).toBe('card.created');
      expect(await board.getPushDeliveries({ status: 'sent' })).toHaveLength(1);
    });
  });

  it('a config without record events gets none of them', async () => {
    await runInDurableObject(stubFor('rec-2'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000b2', tenantId: 'tnt_a', name: 'R', stages: BUILD });
      await board.registerPushConfig({ agentId: 'agt_b', url: HOOK, token: 's', capabilities: ['build'], events: ['work.available'] });
      await board.createCard({ title: 'x', ownerUserId: 'usr_a' });
      expect((await board.getPushDeliveries()).map((d) => JSON.parse(d.body).event)).toEqual(['work.available']);
    });
  });

  it('refuses an event no one emits', async () => {
    await runInDurableObject(stubFor('rec-3'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000b3', tenantId: 'tnt_a', name: 'R', stages: BUILD });
      const r = await board.registerPushConfig({ agentId: 'agt_b', url: HOOK, token: 's', events: ['card.exploded'] });
      expect(r).toMatchObject({ ok: false, code: 'UNKNOWN_EVENT' });
    });
  });

  it('a manual stage move is pushed as card.moved', async () => {
    await runInDurableObject(stubFor('rec-6'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000b6', tenantId: 'tnt_a', name: 'R', stages: BUILD });
      await board.registerPushConfig({ agentId: SVC, url: HOOK, token: 's', events: ['card.moved'] });
      const cardId = idOf(await board.createCard({ title: 'a', ownerUserId: 'usr_a' }));
      expect((await board.moveCard(cardId, 'ship', 'usr_a')).ok).toBe(true);
      const bodies = (await board.getPushDeliveries()).map((d) => JSON.parse(d.body));
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ event: 'card.moved', cardIds: [cardId] });
    });
  });

  it('a link event names both cards', async () => {
    await runInDurableObject(stubFor('rec-4'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000b4', tenantId: 'tnt_a', name: 'R', stages: BUILD });
      await board.registerPushConfig({ agentId: SVC, url: HOOK, token: 's', events: ['link.added'] });
      const a = idOf(await board.createCard({ title: 'a', ownerUserId: 'usr_a' }));
      const b = idOf(await board.createCard({ title: 'b', ownerUserId: 'usr_a' }));
      await board.addLink({ fromCardId: b, toCardId: a, kind: 'relates' });
      const body = JSON.parse((await board.getPushDeliveries())[0]!.body);
      expect(body).toMatchObject({ event: 'link.added', cardIds: [b, a] });
    });
  });

  it('a removed link still names both cards', async () => {
    await runInDurableObject(stubFor('rec-7'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000b7', tenantId: 'tnt_a', name: 'R', stages: BUILD });
      await board.registerPushConfig({ agentId: SVC, url: HOOK, token: 's', events: ['link.removed'] });
      const a = idOf(await board.createCard({ title: 'a', ownerUserId: 'usr_a' }));
      const b = idOf(await board.createCard({ title: 'b', ownerUserId: 'usr_a' }));
      await board.addLink({ fromCardId: b, toCardId: a, kind: 'relates' });
      expect((await board.removeLink(b, a, 'relates')).ok).toBe(true);
      const bodies = (await board.getPushDeliveries()).map((d) => JSON.parse(d.body));
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ event: 'link.removed', cardIds: [b, a] });
    });
  });

  it('cardIdsOf reads the shapes emit carries', () => {
    expect(cardIdsOf({ fromCardId: 'f', toCardId: 't', kind: 'relates' })).toEqual(['f', 't']);
    expect(cardIdsOf({ link: { fromCardId: 'f', toCardId: 't' } })).toEqual(['f', 't']);
    expect(cardIdsOf({ cardId: 'c' })).toEqual(['c']);
    expect(cardIdsOf({ card: { id: 'c' } })).toEqual(['c']);
    expect(cardIdsOf({})).toEqual([]);
  });
});

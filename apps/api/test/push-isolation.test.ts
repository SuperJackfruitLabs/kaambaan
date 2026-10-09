import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BoardDO, BoardInit } from '../src/board/board-do';
import type { PushSender } from '../src/push/deliver';

const BUILD: BoardInit['stages'] = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];
const A = 'https://a.example.com/hook';
const B = 'https://b.example.com/hook';
const stubFor = (n: string) => env.BOARD_DO.get(env.BOARD_DO.idFromName(n)) as unknown as DurableObjectStub<BoardDO>;
const idOf = (r: unknown) => (r as { ok: true; value: { id: string } }).value.id;

describe('push delivery isolation', () => {
  it('a failing config neither exceeds its share of a drain nor delays another config', async () => {
    await runInDurableObject(stubFor('iso-1'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000d1', tenantId: 'tnt_a', name: 'I', stages: BUILD });
      await board.registerPushConfig({ agentId: 'svc:prn_000000000000000000a2', url: A, token: 's', events: ['link.added'] });
      const a = idOf(await board.createCard({ title: 'a', ownerUserId: 'usr_a' }));
      const link = async (n: number) => {
        for (let i = 0; i < n; i++) {
          const c = idOf(await board.createCard({ title: `c${i}`, ownerUserId: 'usr_a' }));
          await board.addLink({ fromCardId: c, toCardId: a, kind: 'relates' });
        }
      };
      await link(25);
      const calls: string[] = [];
      const failA: PushSender = async (url) => { calls.push(url); return { status: url === A ? 500 : 200 }; };
      await board.dispatchPushDeliveries(failA);
      expect(calls.filter((u) => u === A)).toHaveLength(10); // per-config cap

      await board.registerPushConfig({ agentId: 'svc:prn_000000000000000000a3', url: B, token: 's', events: ['link.added'] });
      await link(1);
      calls.length = 0;
      await board.dispatchPushDeliveries(failA);
      // B is served, A takes only its share, and A's share is its fresh rows: no row was retried twice.
      expect(calls).toContain(B);
      expect(calls.filter((u) => u === A)).toHaveLength(10);
      const attempts = (await board.getPushDeliveries()).filter((d) => d.url === A).map((d) => d.attempts);
      expect(Math.max(...attempts)).toBe(1);
    });
  });

  it('cuts a sender that hangs', async () => {
    await runInDurableObject(stubFor('iso-2'), async (board: BoardDO) => {
      await board.init({ id: 'brd_00000000000000d2', tenantId: 'tnt_a', name: 'I', stages: BUILD });
      await board.registerPushConfig({ agentId: 'svc:prn_000000000000000000a2', url: A, token: 's', events: ['link.added'] });
      const a = idOf(await board.createCard({ title: 'a', ownerUserId: 'usr_a' }));
      const b = idOf(await board.createCard({ title: 'b', ownerUserId: 'usr_a' }));
      await board.addLink({ fromCardId: b, toCardId: a, kind: 'relates' });
      let signal: AbortSignal | undefined;
      const hang: PushSender = (_u, init) => { signal = init.signal; return new Promise(() => {}); };
      const r = await board.dispatchPushDeliveries(hang, { timeoutMs: 20 });
      expect(r).toEqual({ sent: 0, failed: 1 });
      expect(signal?.aborted).toBe(true);
    });
  });
});

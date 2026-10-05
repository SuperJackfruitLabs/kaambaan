import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import worker from '../src/index';
import type { BoardDO } from '../src/board/board-do';
import { fakeSuperwitness, withReporting, trackBoard, quietBoards } from './helpers/superwitness';

const TENANT = 'tnt_swcron';
const H = { 'X-Tenant-Id': TENANT, 'Content-Type': 'application/json' };

afterEach(quietBoards);

describe('the five-minute cron drains the superwitness outbox (backstop)', () => {
  it('sends a due report whose alarm was lost', async () => {
    const created = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Cron', stages: [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }] }),
    });
    const { boardId } = (await created.json()) as { boardId: string };
    const stub = trackBoard(env.BOARD_DO.get(env.BOARD_DO.idFromName(`${TENANT}:${boardId}`)) as unknown as DurableObjectStub<BoardDO>);

    const sw = fakeSuperwitness();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.startsWith('https://sw.test') || url.startsWith('https://hub.test') ? sw.fetcher(url, init ?? {}) : realFetch(input, init);
    }) as typeof fetch;
    try {
      await withReporting(async () => {
        await runInDurableObject(stub, async (board: BoardDO, state) => {
          await board.createCard({ title: 'C', ownerUserId: 'usr_a' });
          const c = await board.claim({ agentId: 'agt_w', capabilities: ['build'] });
          expect(c.claimed).toBe(true);
          await state.storage.deleteAlarm(); // the missed alarm the backstop exists for
        });
        const waits: Promise<unknown>[] = [];
        await worker.scheduled(
          {} as ScheduledController,
          env,
          { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext,
        );
        await Promise.all(waits);
      });
      expect(sw.batches.some((b) => b.body.runs.some((r) => String(r.external_ref).startsWith(`${boardId}/`)))).toBe(true);
      await runInDurableObject(stub, async (board: BoardDO) => expect(await board.getRunReportOutbox()).toEqual([]));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

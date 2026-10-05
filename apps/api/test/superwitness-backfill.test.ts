import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { BoardDO } from '../src/board/board-do';
import { createAgent, createAgentToken } from '../src/db/catalog';
import { runRow, withReporting, trackBoard, quietBoards } from './helpers/superwitness';

const BASE = 'https://api.test';
const STAGES = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];

async function boardWithRuns(tenant: string, n: number): Promise<{ boardId: string; stub: DurableObjectStub<BoardDO>; runIds: string[] }> {
  const res = await SELF.fetch(`${BASE}/v1/boards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Backfill', stages: STAGES }),
  });
  const { boardId } = (await res.json()) as { boardId: string };
  const stub = trackBoard(env.BOARD_DO.get(env.BOARD_DO.idFromName(`${tenant}:${boardId}`)) as unknown as DurableObjectStub<BoardDO>);
  const runIds = await runInDurableObject(stub, async (board: BoardDO) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      await board.createCard({ title: `C${i}`, ownerUserId: 'usr_a' });
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['build'], maxConcurrency: 10 });
      if (!c.claimed) throw new Error('expected a claim');
      ids.push(c.runId);
    }
    return ids;
  });
  return { boardId, stub, runIds };
}

function backfill(tenant: string, body: unknown, extra: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}/v1/admin/superwitness/backfill`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenant, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
}

// Reporting on arms a due-at-once alarm; its drain would try a real fetch to the hub. Refuse
// at once so it fails fast and the row just backs off (attempts change, reported_at does not).
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://sw.test') || url.startsWith('https://hub.test')) return Promise.reject(new TypeError('network down'));
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(async () => {
  await quietBoards();
  globalThis.fetch = realFetch;
});

describe('POST /v1/admin/superwitness/backfill', () => {
  it('enqueues one report per run at each run’s own update time, and is idempotent', async () => {
    const { boardId, stub, runIds } = await boardWithRuns('tnt_bf', 2); // made while reporting is off: no rows
    await withReporting(async () => {
      const first = await backfill('tnt_bf', { board_id: boardId });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ board_id: boardId, enqueued: 2, pending: 2, dead: 0 });
      const before = await runInDurableObject(stub, async (board: BoardDO, state) => {
        const rows = await board.getRunReportOutbox();
        for (const r of rows) expect(r.reportedAt).toBe(runRow(state, r.runId).updated_at);
        return { rows: rows.map((r) => [r.runId, r.reportedAt]).sort(), updated: runIds.map((id) => runRow(state, id).updated_at) };
      });
      expect(before.rows.map(([id]) => id)).toEqual([...runIds].sort());

      const second = await backfill('tnt_bf', { board_id: boardId });
      expect(await second.json()).toEqual({ board_id: boardId, enqueued: 2, pending: 2, dead: 0 });
      await runInDurableObject(stub, async (board: BoardDO, state) => {
        expect((await board.getRunReportOutbox()).map((r) => [r.runId, r.reportedAt]).sort()).toEqual(before.rows);
        expect(runIds.map((id) => runRow(state, id).updated_at)).toEqual(before.updated); // never bumped
      });
    });
  });

  it('reports a pre-column run at COALESCE(updated_at, ended_at, started_at)', async () => {
    const { boardId, stub, runIds } = await boardWithRuns('tnt_bf_legacy', 1);
    await runInDurableObject(stub, async (_b: BoardDO, state) => {
      state.storage.sql.exec(`UPDATE runs SET updated_at = NULL`);
    });
    await withReporting(async () => {
      await backfill('tnt_bf_legacy', { board_id: boardId });
      await runInDurableObject(stub, async (board: BoardDO, state) => {
        expect((await board.getRunReportOutbox())[0]!.reportedAt).toBe(runRow(state, runIds[0]!).started_at);
      });
    });
  });

  it('revives parked rows (the repair tool)', async () => {
    const { boardId, stub } = await boardWithRuns('tnt_bf_repair', 1);
    await withReporting(async () => {
      await backfill('tnt_bf_repair', { board_id: boardId });
      await runInDurableObject(stub, async (_b: BoardDO, state) => {
        state.storage.sql.exec(`UPDATE run_reports SET status = 'dead', attempts = 12, last_error = '400 bad_request'`);
      });
      expect(await (await backfill('tnt_bf_repair', { board_id: boardId })).json()).toMatchObject({ pending: 1, dead: 0 });
    });
  });

  it('409 when reporting is off', async () => {
    const { boardId, stub } = await boardWithRuns('tnt_bf_off', 1);
    const res = await backfill('tnt_bf_off', { board_id: boardId });
    expect(res.status).toBe(409);
    await runInDurableObject(stub, async (board: BoardDO) => expect(await board.getRunReportOutbox()).toEqual([]));
  });

  it('404 for a board in another workspace', async () => {
    const { boardId } = await boardWithRuns('tnt_bf_other', 1);
    await withReporting(async () => {
      // Refused at the catalog, before a Durable Object is woken (or created) under another name.
      const res = await backfill('tnt_bf_mine', { board_id: boardId });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'board not found' });
    });
  });

  it('403 for a member who is not an admin', async () => {
    const { boardId } = await boardWithRuns('tnt_bf_roles', 1);
    await env.DB.prepare(`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('mem_bf1', 'tnt_bf_roles', 'usr_m', 'member')`).run();
    await withReporting(async () => {
      expect((await backfill('tnt_bf_roles', { board_id: boardId }, { 'X-User-Id': 'usr_m' })).status).toBe(403);
    });
  });

  it('refuses an agent credential', async () => {
    const { boardId } = await boardWithRuns('tnt_bf_agent', 1);
    const agent = await createAgent(env.DB, 'tnt_bf_agent', { name: 'a' });
    const { token } = await createAgentToken(env.DB, 'tnt_bf_agent', agent.id, ['claim', 'run', 'read']);
    await withReporting(async () => {
      const res = await SELF.fetch(`${BASE}/v1/admin/superwitness/backfill`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ board_id: boardId }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('400 without a board_id; 405 for GET', async () => {
    await withReporting(async () => {
      expect((await backfill('tnt_bf_bad', {})).status).toBe(400);
      expect((await SELF.fetch(`${BASE}/v1/admin/superwitness/backfill`, { headers: { 'X-Tenant-Id': 'tnt_bf_bad' } })).status).toBe(405);
    });
  });
});

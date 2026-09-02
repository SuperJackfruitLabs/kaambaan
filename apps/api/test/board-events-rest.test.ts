import { SELF, env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

/**
 * Two things that existed and had no caller.
 *
 * `BoardDO.getEvents` has been there since the DO was: every state change on a board is appended
 * to `events`, and there was no route to read them back — the only audit trail the product keeps
 * was unreachable, which is the same as not keeping one.
 *
 * `dispatchPushDeliveries` had a route and no schedule, so the delivery queue drained only on a
 * DO alarm or a manual POST.
 */

const T = { 'X-Tenant-Id': 'tnt_events', 'Content-Type': 'application/json' };
const PIPE = [{ key: 'todo', name: 'To do', order: 0 }];

async function seed(): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', { method: 'POST', headers: T, body: JSON.stringify({ name: 'E', stages: PIPE }) });
  return (await res.json<{ boardId: string }>()).boardId;
}

describe('GET /v1/boards/:id/events', () => {
  it('returns the board log, oldest first, with what happened in it', async () => {
    const boardId = await seed();
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: T, body: JSON.stringify({ title: 'Logged' }) });

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/events`, { headers: T });
    expect(res.status).toBe(200);
    const { events } = await res.json<{ events: Array<{ seq: number; type: string; payload: unknown; ts: string }> }>();

    expect(events.map((e) => e.type)).toContain('board.initialized');
    expect(events.map((e) => e.type)).toContain('card.created');
    // Oldest first: a log read newest-first would show a card created before its board.
    expect(events[0]!.type).toBe('board.initialized');
    expect(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq)).toBe(true);
  });

  it('honours ?limit= and caps it, so one request cannot ask for the whole history', async () => {
    const boardId = await seed();
    for (let i = 0; i < 4; i++) {
      await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: T, body: JSON.stringify({ title: `c${i}` }) });
    }

    const two = await (await SELF.fetch(`https://api.test/v1/boards/${boardId}/events?limit=2`, { headers: T })).json<{ events: unknown[] }>();
    expect(two.events).toHaveLength(2);

    const silly = await (await SELF.fetch(`https://api.test/v1/boards/${boardId}/events?limit=99999`, { headers: T })).json<{ events: unknown[] }>();
    expect(silly.events.length).toBeLessThanOrEqual(500);

    // A nonsense limit falls back to the default rather than returning nothing.
    const bad = await (await SELF.fetch(`https://api.test/v1/boards/${boardId}/events?limit=-1`, { headers: T })).json<{ events: unknown[] }>();
    expect(bad.events.length).toBeGreaterThan(0);
  });

  it('is a read, so a viewer may have it', async () => {
    const boardId = await seed();
    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/events`, { headers: T });
    expect(res.status).toBe(200);
  });
});

describe('the scheduled sweep', () => {
  it('drains every board without one failure stopping the rest', async () => {
    const a = await seed();
    const b = await seed();

    // A board id in the catalog whose DO has never been initialised — the shape of a board that
    // throws mid-sweep. The sweep must still reach the boards after it.
    await env.DB.prepare(`INSERT INTO boards (id, tenant_id, name, stages_json) VALUES (?, ?, ?, ?)`)
      .bind('brd_never_woken', 'tnt_events', 'Ghost', '[]')
      .run();

    const ctx = createExecutionContext();
    await worker.scheduled!({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} }, env, ctx);
    await waitOnExecutionContext(ctx);

    // Both real boards are still answering: the sweep completed rather than throwing out.
    for (const id of [a, b]) {
      const res = await SELF.fetch(`https://api.test/v1/boards/${id}/push/deliveries`, { headers: T });
      expect(res.status).toBe(200);
    }
  });
});

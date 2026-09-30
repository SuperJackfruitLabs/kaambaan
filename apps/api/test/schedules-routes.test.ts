import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { BoardInit } from '../src/board/board-do';

/**
 * `GET|POST /v1/boards/:id/schedules` and `PATCH|DELETE /v1/boards/:id/schedules/:scheduleId` —
 * the routing and route-level validation layer over Task 9's `createSchedule`/`updateSchedule` on
 * the DO. `board-do.ts`'s own `test/schedules.test.ts` calls the DO directly and never exercises
 * these routes at all — none of Task 9's work was reachable by a person before this file.
 *
 * `createSchedule`/`updateSchedule` validate the RULE, timezone, stageKey, overlap and createdBy
 * — but the DO trusts its caller's JSON SHAPE by design (it cannot reach D1 on a hot path), so a
 * non-string `rule` reaching `parseRule`'s `.trim()` throws inside the DO rather than answering a
 * 400 — the same class of hole `dueAt: 12345` opened on `POST /cards` (docs: whole-branch review).
 * These are route-level type guards, refusing malformed shapes before the DO ever sees them.
 */

const PIPE: BoardInit['stages'] = [{ key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' }];
const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

async function board(tenant: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: dev(tenant),
    body: JSON.stringify({ name: 'Schedules', stages: PIPE }),
  });
  return (await res.json<{ boardId: string }>()).boardId;
}

describe('GET /v1/boards/:id/schedules', () => {
  it('answers an empty list for a board with none', async () => {
    const t = 'tnt_sch_empty';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, { headers: dev(t) });
    expect(res.status).toBe(200);
    expect((await res.json<{ schedules: unknown[] }>()).schedules).toEqual([]);
  });

  it('lists a schedule after it is created', async () => {
    const t = 'tnt_sch_list';
    const b = await board(t);
    await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'Sweep logs', rule: 'daily at 09:00', timezone: 'UTC' }),
    });
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, { headers: dev(t) });
    const { schedules } = await res.json<{ schedules: Array<{ title: string }> }>();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.title).toBe('Sweep logs');
  });
});

describe('POST /v1/boards/:id/schedules', () => {
  it('creates a schedule, stamping the signed-in user as createdBy', async () => {
    const t = 'tnt_sch_create';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'Sweep logs', rule: 'daily at 09:00', timezone: 'UTC' }),
    });
    expect(res.status).toBe(201);
    const { schedule } = await res.json<{ schedule: { id: string; nextFireAt: string; overlap: string; createdBy: string | null } }>();
    expect(schedule.id).toMatch(/^sch_/);
    expect(schedule.nextFireAt).toMatch(/T09:00:00\.000Z$/);
    // Overlap defaults to 'skip' when the caller does not send one.
    expect(schedule.overlap).toBe('skip');
    // `createdBy` is never read from the body — the route stamps the signed-in user — and it is
    // validated hard at creation, then becomes the future card's owner. Asserted here because the
    // chain authenticated-user → created_by → card.ownerUserId had no coverage at all before this.
    expect(schedule.createdBy).toBe('usr_dev');
  });

  it('stores the operator\'s own timezone spelling, never the resolved one', async () => {
    const t = 'tnt_sch_tz';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'Sweep logs', rule: 'daily at 09:00', timezone: 'Asia/Kolkata' }),
    });
    const { schedule } = await res.json<{ schedule: { timezone: string } }>();
    // ICU canonicalises this to Asia/Calcutta; the stored/echoed value must not be that.
    expect(schedule.timezone).toBe('Asia/Kolkata');
  });

  it('returns the parser\'s own message verbatim on an unreadable rule', async () => {
    const t = 'tnt_sch_badrule';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'every 2 minutes', timezone: 'UTC' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { message: string } }>();
    expect(body.error.message).toContain('5');
    expect(body.error.message).toContain('shortest interval');
  });

  it('refuses a non-string rule at the route, before it ever reaches the DO', async () => {
    const t = 'tnt_sch_rule_type';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 12345, timezone: 'UTC' }),
    });
    // Must be a clean 400, not a 500 from `parseRule`'s `.trim()` throwing on a number.
    expect(res.status).toBe(400);
  });

  it('refuses a non-string title at the route', async () => {
    const t = 'tnt_sch_title_type';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 42, rule: 'daily at 09:00', timezone: 'UTC' }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a non-string timezone at the route', async () => {
    const t = 'tnt_sch_tz_type';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'daily at 09:00', timezone: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an unreadable timezone with the DO\'s own message', async () => {
    const t = 'tnt_sch_badtz';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'daily at 09:00', timezone: 'Nowhere/Fake' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { message: string } }>();
    expect(body.error.message).toContain('Nowhere/Fake');
  });

  it('refuses an overlap of {} at the route rather than letting it reach the DO', async () => {
    const t = 'tnt_sch_overlap_obj';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'daily at 09:00', timezone: 'UTC', overlap: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an unknown stage as a 400', async () => {
    const t = 'tnt_sch_stage';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'daily at 09:00', timezone: 'UTC', stageKey: 'nope' }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a non-array labels field at the route', async () => {
    const t = 'tnt_sch_labels_type';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'daily at 09:00', timezone: 'UTC', labels: 'urgent' }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a non-numeric priority at the route', async () => {
    const t = 'tnt_sch_priority_type';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'daily at 09:00', timezone: 'UTC', priority: 'high' }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a string spec at the route, before it can spread into an indexed object', async () => {
    // `board-do.ts` does `{ ...(JSON.parse(row.spec_json) as Record<string, unknown>), scheduleId }`
    // when a schedule fires. A string is iterable, so `spec: "urgent"` would silently become
    // `{0:'u',1:'r',2:'g',...,scheduleId:'sch_…'}` on the minted card instead of being refused —
    // the exact class of hole the other shape guards on this route exist to close, reopened here.
    const t = 'tnt_sch_spec_string';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'daily at 09:00', timezone: 'UTC', spec: 'urgent' }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a null spec at the route', async () => {
    const t = 'tnt_sch_spec_null';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'daily at 09:00', timezone: 'UTC', spec: null }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an array spec at the route', async () => {
    const t = 'tnt_sch_spec_array';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'daily at 09:00', timezone: 'UTC', spec: ['urgent'] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /v1/boards/:id/schedules/:scheduleId', () => {
  async function created(t: string, b: string): Promise<string> {
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'Sweep logs', rule: 'daily at 09:00', timezone: 'UTC' }),
    });
    return (await res.json<{ schedule: { id: string } }>()).schedule.id;
  }

  it('pauses (enabled: false) and resumes (enabled: true) a schedule', async () => {
    const t = 'tnt_sch_pause';
    const b = await board(t);
    const id = await created(t, b);

    const paused = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ enabled: false }),
    });
    expect(paused.status).toBe(200);
    expect((await paused.json<{ schedule: { enabled: boolean } }>()).schedule.enabled).toBe(false);

    const resumed = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ enabled: true }),
    });
    expect((await resumed.json<{ schedule: { enabled: boolean } }>()).schedule.enabled).toBe(true);
  });

  it('404s for a schedule that does not exist', async () => {
    const t = 'tnt_sch_notfound';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules/sch_nope`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it('refuses a non-string rule patch at the route', async () => {
    const t = 'tnt_sch_patch_rule_type';
    const b = await board(t);
    const id = await created(t, b);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ rule: 999 }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an overlap of {} on patch too', async () => {
    const t = 'tnt_sch_patch_overlap_obj';
    const b = await board(t);
    const id = await created(t, b);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ overlap: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a string spec on patch too', async () => {
    const t = 'tnt_sch_patch_spec_string';
    const b = await board(t);
    const id = await created(t, b);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ spec: 'urgent' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /v1/boards/:id/schedules/:scheduleId', () => {
  it('removes a schedule', async () => {
    const t = 'tnt_sch_delete';
    const b = await board(t);
    const createRes = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'x', rule: 'daily at 09:00', timezone: 'UTC' }),
    });
    const { schedule } = await createRes.json<{ schedule: { id: string } }>();

    const del = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules/${schedule.id}`, {
      method: 'DELETE',
      headers: dev(t),
    });
    expect(del.status).toBe(204);

    const list = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules`, { headers: dev(t) });
    expect((await list.json<{ schedules: unknown[] }>()).schedules).toEqual([]);
  });

  it('404s deleting a schedule that does not exist', async () => {
    const t = 'tnt_sch_delete_404';
    const b = await board(t);
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/schedules/sch_nope`, {
      method: 'DELETE',
      headers: dev(t),
    });
    expect(res.status).toBe(404);
  });
});

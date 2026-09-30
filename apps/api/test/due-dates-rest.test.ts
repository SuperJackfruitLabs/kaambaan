import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { BoardInit } from '../src/board/board-do';

/**
 * Route-level validation for `dueAt`/`archivedAt` on `PATCH /v1/boards/:id/cards/:cardId`.
 *
 * Same hazard the `labels` guard (test/labels-rest.test.ts) closes: the route was passing the raw
 * request body straight into `stub.updateCard`, so a malformed `dueAt` either threw inside the DO
 * (a 5xx instead of a 400) or was stored verbatim and then silently drove claim order and the
 * overdue cron sweep on a board nobody is watching.
 */

const PIPE: BoardInit['stages'] = [{ key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' }];
const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

async function board(tenant: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: dev(tenant),
    body: JSON.stringify({ name: 'Due dates', stages: PIPE }),
  });
  return (await res.json<{ boardId: string }>()).boardId;
}

async function card(tenant: string, boardId: string, title: string): Promise<string> {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: dev(tenant),
    body: JSON.stringify({ title }),
  });
  return (await res.json<{ card: { id: string } }>()).card.id;
}

async function readCard(tenant: string, boardId: string, cardId: string): Promise<{ dueAt: string | null; archivedAt: string | null }> {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${cardId}`, { headers: dev(tenant) });
  return (await res.json<{ card: { dueAt: string | null; archivedAt: string | null } }>()).card;
}

describe('POST /v1/boards/:id/cards — dueAt validation', () => {
  it('400s a malformed dueAt at creation, reusing the PATCH rule', async () => {
    const t = 'tnt_due_rest_create_bad';
    const b = await board(t);

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'Bad due at birth', dueAt: 'next tuesday' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('INVALID_DUE_AT');
  });

  it('accepts a well-formed dueAt at creation, with no follow-up patch needed', async () => {
    const t = 'tnt_due_rest_create_ok';
    const b = await board(t);

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ title: 'Dated at birth', dueAt: '2026-12-01' }),
    });
    expect(res.status).toBe(201);
    const created = await res.json<{ card: { id: string; dueAt: string | null } }>();
    expect(created.card.dueAt).toBe('2026-12-01');
    expect((await readCard(t, b, created.card.id)).dueAt).toBe('2026-12-01');
  });
});

describe('PATCH /v1/boards/:id/cards/:cardId — dueAt validation', () => {
  it('400s a non-string dueAt instead of throwing inside the DO', async () => {
    const t = 'tnt_due_rest_num';
    const b = await board(t);
    const id = await card(t, b, 'Bad due');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ dueAt: 12345 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('INVALID_DUE_AT');

    const after = await readCard(t, b, id);
    expect(after.dueAt).toBeNull();
  });

  it('400s a string that is not a bare YYYY-MM-DD date', async () => {
    const t = 'tnt_due_rest_prose';
    const b = await board(t);
    const id = await card(t, b, 'Prose due');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ dueAt: 'next tuesday' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('INVALID_DUE_AT');

    const after = await readCard(t, b, id);
    expect(after.dueAt).toBeNull();
  });

  it('accepts a well-formed date and accepts null to clear it', async () => {
    const t = 'tnt_due_rest_ok';
    const b = await board(t);
    const id = await card(t, b, 'Good due');

    const set = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ dueAt: '2026-12-01' }),
    });
    expect(set.status).toBe(200);
    expect((await readCard(t, b, id)).dueAt).toBe('2026-12-01');

    const clear = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ dueAt: null }),
    });
    expect(clear.status).toBe(200);
    expect((await readCard(t, b, id)).dueAt).toBeNull();
  });
});

describe('PATCH /v1/boards/:id/cards/:cardId — archivedAt validation', () => {
  it('400s a non-string archivedAt', async () => {
    const t = 'tnt_arch_rest_num';
    const b = await board(t);
    const id = await card(t, b, 'Bad archive');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ archivedAt: 12345 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('INVALID_ARCHIVED_AT');

    const after = await readCard(t, b, id);
    expect(after.archivedAt).toBeNull();
  });

  it('400s a string that does not parse as a timestamp', async () => {
    const t = 'tnt_arch_rest_prose';
    const b = await board(t);
    const id = await card(t, b, 'Prose archive');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ archivedAt: 'not a date' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('INVALID_ARCHIVED_AT');

    const after = await readCard(t, b, id);
    expect(after.archivedAt).toBeNull();
  });

  it('accepts a well-formed ISO timestamp and accepts null to clear it', async () => {
    const t = 'tnt_arch_rest_ok';
    const b = await board(t);
    const id = await card(t, b, 'Good archive');

    const set = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ archivedAt: '2026-09-30T00:00:00.000Z' }),
    });
    expect(set.status).toBe(200);
    expect((await readCard(t, b, id)).archivedAt).toBe('2026-09-30T00:00:00.000Z');

    const clear = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ archivedAt: null }),
    });
    expect(clear.status).toBe(200);
    expect((await readCard(t, b, id)).archivedAt).toBeNull();
  });
});

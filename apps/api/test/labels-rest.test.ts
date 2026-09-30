import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { BoardInit } from '../src/board/board-do';

/**
 * `/v1/labels[/:id]` and the labels validation on `PATCH /v1/boards/:id/cards/:cardId` — the
 * routing and validation layer over `src/db/labels.ts`, which the module-level tests
 * (`test/labels.test.ts`) never exercise because they call the DB module or the DO directly.
 *
 * Two defects lived here, invisible to that suite: a catch-all in `POST /v1/labels` that reported
 * EVERY create failure as a 409 name collision (discarding the real error), and a missing type
 * guard on `PATCH .../cards/:cardId`'s `labels` field that let `labels: "urgent"` (a bare string)
 * skip validation entirely and reach `[...new Set(patch.labels)]` in the DO, where a string is
 * iterable and spreads into its individual characters — silently corrupting stored card data.
 */

const PIPE: BoardInit['stages'] = [{ key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' }];
const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

/**
 * `labels` (migration 0010) carries `REFERENCES tenants(id)`, unlike every other table the test
 * catalog mirrors — the FK is kept because the real migration file is run as-is (see
 * `test/helpers/catalog.ts`). A route that writes into `labels` through a dev-header tenant with
 * no `tenants` row fails on that FK, so any test that creates a label inserts one first.
 */
async function insertTenant(id: string, slug: string): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, ?)`).bind(id, slug, slug).run();
}

async function board(tenant: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: dev(tenant),
    body: JSON.stringify({ name: 'Labels', stages: PIPE }),
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

async function readCard(tenant: string, boardId: string, cardId: string): Promise<{ labels: string[] }> {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${cardId}`, { headers: dev(tenant) });
  return (await res.json<{ card: { labels: string[] } }>()).card;
}

describe('POST /v1/labels', () => {
  it('refuses a duplicate name as a 409 sentence, not a raw constraint failure', async () => {
    const t = 'tnt_lbl_rest_dupe';
    await insertTenant(t, 'lbl-rest-dupe');
    const body = JSON.stringify({ name: 'urgent', colour: '#f00' });

    const first = await SELF.fetch('https://api.test/v1/labels', { method: 'POST', headers: dev(t), body });
    expect(first.status).toBe(201);

    const again = await SELF.fetch('https://api.test/v1/labels', {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: '  urgent  ', colour: '#0f0' }), // untrimmed, same collision
    });
    expect(again.status).toBe(409);
    // The message names the trimmed name actually attempted, not the raw untrimmed body value.
    expect((await again.json<{ error: string }>()).error).toContain('"urgent"');
  });

  /**
   * The risk the brief named by name: migration 0011 added a SECOND unique index
   * (`labels_tenant_name_nocase`) beside 0010's original `UNIQUE (tenant_id, name)`. If that new
   * index's constraint-failure message differed from the old one, `isLabelNameCollision` would
   * stop matching for exactly this case — a case-variant duplicate — and this request would come
   * back 500 instead of 409.
   *
   * This runs against the REAL D1/Miniflare engine via `SELF.fetch`, not a standalone `sqlite3`
   * session — the two are very likely to agree, but "very likely" is not a substitute for a test
   * that actually exercises the code path this risk lives in.
   */
  it('refuses a duplicate that differs only in case as a 409 sentence, not a raw constraint failure', async () => {
    const t = 'tnt_lbl_rest_dupe_case';
    await insertTenant(t, 'lbl-rest-dupe-case');

    const first = await SELF.fetch('https://api.test/v1/labels', {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'Urgent', colour: '#f00' }),
    });
    expect(first.status).toBe(201);

    const again = await SELF.fetch('https://api.test/v1/labels', {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'urgent', colour: '#0f0' }), // differs only in case
    });
    expect(again.status).toBe(409);
    // Not just "some 4xx" — the matcher actually fired and produced the collision sentence,
    // rather than the request failing for an unrelated reason that happens to also be a 409.
    expect((await again.json<{ error: string }>()).error).toContain('already exists');
  });
});

describe('PATCH /v1/labels/:id', () => {
  it('refuses a rename onto an existing name as a 409 sentence, not a 500', async () => {
    const t = 'tnt_lbl_rest_patch_dupe';
    await insertTenant(t, 'lbl-rest-patch-dupe');
    await SELF.fetch('https://api.test/v1/labels', {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'taken', colour: '#f00' }),
    });
    const made = await SELF.fetch('https://api.test/v1/labels', {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'renameable', colour: '#0f0' }),
    });
    const { label } = await made.json<{ label: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/labels/${label.id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ name: 'taken' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('"taken"');
  });

  it('refuses a rename to an empty name as a 400, not a 500', async () => {
    const t = 'tnt_lbl_rest_patch_empty';
    await insertTenant(t, 'lbl-rest-patch-empty');
    const made = await SELF.fetch('https://api.test/v1/labels', {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'has-a-name', colour: '#00f' }),
    });
    const { label } = await made.json<{ label: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/labels/${label.id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /v1/boards/:id/cards/:cardId — labels validation', () => {
  it('400s a bare string instead of spreading its characters into storage', async () => {
    const t = 'tnt_lbl_rest_string';
    const b = await board(t);
    const id = await card(t, b, 'Malformed');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ labels: 'urgent' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('INVALID_LABELS');

    // The corruption is the point: confirm storage was never touched, not just the status code.
    const after = await readCard(t, b, id);
    expect(after.labels).toEqual([]);
  });

  it('400s an array containing a non-string element', async () => {
    const t = 'tnt_lbl_rest_numarr';
    const b = await board(t);
    const id = await card(t, b, 'Malformed 2');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ labels: [123] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('INVALID_LABELS');

    const after = await readCard(t, b, id);
    expect(after.labels).toEqual([]);
  });

  it('400s a well-formed but unknown label id, naming only the unknown one', async () => {
    const t = 'tnt_lbl_rest_unknown';
    await insertTenant(t, 'lbl-rest-unknown');
    const b = await board(t);
    const id = await card(t, b, 'Unknown label');

    const made = await SELF.fetch('https://api.test/v1/labels', {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'known', colour: '#00f' }),
    });
    const { label } = await made.json<{ label: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ labels: [label.id, 'lbl_deadbeefdeadbeef'] }),
    });
    expect(res.status).toBe(400);
    const err = (await res.json<{ error: { code: string; message: string } }>()).error;
    expect(err.code).toBe('UNKNOWN_LABEL');
    expect(err.message).toContain('lbl_deadbeefdeadbeef');
    expect(err.message).not.toContain(label.id);

    // Refused before the write lands — the card carries neither the known nor the unknown id.
    const after = await readCard(t, b, id);
    expect(after.labels).toEqual([]);
  });

  it('accepts a well-formed, all-known array', async () => {
    const t = 'tnt_lbl_rest_ok';
    await insertTenant(t, 'lbl-rest-ok');
    const b = await board(t);
    const id = await card(t, b, 'Good label');

    const made = await SELF.fetch('https://api.test/v1/labels', {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'ready', colour: '#0f0' }),
    });
    const { label } = await made.json<{ label: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ labels: [label.id] }),
    });
    expect(res.status).toBe(200);
    const after = await readCard(t, b, id);
    expect(after.labels).toEqual([label.id]);
  });
});

describe('PATCH /v1/boards/:id/cards/:cardId — labelNames (the drawer\'s free-text input)', () => {
  it('resolves typed names to ids, creating one that does not exist yet', async () => {
    const t = 'tnt_lbl_rest_names';
    await insertTenant(t, 'lbl-rest-names');
    const b = await board(t);
    const id = await card(t, b, 'Drawer card');

    const made = await SELF.fetch('https://api.test/v1/labels', {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'bug', colour: '#f00' }),
    });
    const { label } = await made.json<{ label: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ labelNames: ['bug', 'freshly typed'] }),
    });
    expect(res.status).toBe(200);
    const after = await readCard(t, b, id);
    expect(after.labels).toHaveLength(2);
    expect(after.labels).toContain(label.id);

    const catalogue = await SELF.fetch('https://api.test/v1/labels', { headers: dev(t) });
    const { labels: all } = await catalogue.json<{ labels: { name: string }[] }>();
    expect(all.some((l) => l.name === 'freshly typed')).toBe(true);
  });

  it('resolves "Urgent" and "urgent" typed on two different requests to the same id', async () => {
    const t = 'tnt_lbl_rest_names_case';
    await insertTenant(t, 'lbl-rest-names-case');
    const b = await board(t);
    const id = await card(t, b, 'Case card');

    await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ labelNames: ['Urgent'] }),
    });
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ labelNames: ['urgent'] }),
    });
    expect(res.status).toBe(200);
    const after = await readCard(t, b, id);
    expect(after.labels).toHaveLength(1);

    const catalogue = await SELF.fetch('https://api.test/v1/labels', { headers: dev(t) });
    const { labels: all } = await catalogue.json<{ labels: { name: string }[] }>();
    expect(all.filter((l) => l.name.toLowerCase() === 'urgent')).toHaveLength(1);
  });

  it('400s a labelNames array containing a non-string element, same as labels does', async () => {
    const t = 'tnt_lbl_rest_names_bad';
    const b = await board(t);
    const id = await card(t, b, 'Bad names');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ labelNames: ['ok', 42] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('INVALID_LABELS');

    const after = await readCard(t, b, id);
    expect(after.labels).toEqual([]);
  });
});

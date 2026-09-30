import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { addExternalLink } from '../src/db/card-links-external';

/**
 * HTTP surface for Task 12's same-board `card_links` (`addLink`/`removeLink`/`listLinks` on the
 * DO, `board-do.ts:2139-2199`) and the read-side merge with Task 16's cross-board advisory rows
 * (`db/card-links-external.ts`). Task 17a: the routes existed on the DO and in D1 but had no
 * wire — this is the wire.
 */

const T = { 'X-Tenant-Id': 'tnt_links', 'Content-Type': 'application/json' };
const base = 'https://api.test';

const STAGES = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];

// `card_links_external` FKs `tenant_id` to `tenants(id)` — a row the board-create route never
// writes, so seeding it is what `addExternalLink` needs to not 500 on the foreign key.
beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_links', 'links', 'Links')`).run();
});

async function createBoard(name = 'Links'): Promise<string> {
  const res = await SELF.fetch(`${base}/v1/boards`, {
    method: 'POST',
    headers: T,
    body: JSON.stringify({ name, stages: STAGES }),
  });
  return ((await res.json()) as { boardId: string }).boardId;
}

async function createCard(boardId: string, title: string): Promise<string> {
  const res = await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: T,
    body: JSON.stringify({ title, ownerUserId: 'usr_owner' }),
  });
  return ((await res.json()) as { card: { id: string } }).card.id;
}

describe('POST /v1/boards/:id/links', () => {
  it('declares a same-board edge and returns it', async () => {
    const bid = await createBoard();
    const a = await createCard(bid, 'A');
    const b = await createCard(bid, 'B');

    const res = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, kind: 'blocks' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { link: { fromCardId: string; toCardId: string; kind: string } };
    expect(body.link).toMatchObject({ fromCardId: a, toCardId: b, kind: 'blocks' });
  });

  it('answers 400 for an unknown kind, refused before the DO is called', async () => {
    const bid = await createBoard();
    const a = await createCard(bid, 'A');
    const b = await createCard(bid, 'B');

    const res = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, kind: 'nonsense' }),
    });
    expect(res.status).toBe(400);
  });

  it('answers 400 when fromCardId/toCardId are missing or blank', async () => {
    const bid = await createBoard();
    const res = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: '', toCardId: 'card_x', kind: 'blocks' }),
    });
    expect(res.status).toBe(400);
  });

  it('answers 404 NO_SUCH_CARD when a named card does not exist', async () => {
    const bid = await createBoard();
    const a = await createCard(bid, 'A');

    const res = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: 'card_ghost', kind: 'blocks' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NO_SUCH_CARD');
  });

  it('answers 409 ALREADY_HAS_PARENT for a second parent edge', async () => {
    const bid = await createBoard();
    const p1 = await createCard(bid, 'P1');
    const p2 = await createCard(bid, 'P2');
    const child = await createCard(bid, 'Child');

    await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: p1, toCardId: child, kind: 'parent' }),
    });
    const res = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: p2, toCardId: child, kind: 'parent' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ALREADY_HAS_PARENT');
  });

  it('answers 409 LINK_WOULD_CYCLE for an edge that closes a loop', async () => {
    const bid = await createBoard();
    const a = await createCard(bid, 'A');
    const b = await createCard(bid, 'B');

    await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, kind: 'blocks' }),
    });
    const res = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: b, toCardId: a, kind: 'blocks' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('LINK_WOULD_CYCLE');
  });
});

describe('DELETE /v1/boards/:id/links', () => {
  it('removes an edge, idempotently', async () => {
    const bid = await createBoard();
    const a = await createCard(bid, 'A');
    const b = await createCard(bid, 'B');
    await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, kind: 'relates' }),
    });

    const res = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'DELETE',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, kind: 'relates' }),
    });
    expect(res.status).toBe(200);

    const again = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'DELETE',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, kind: 'relates' }),
    });
    expect(again.status).toBe(200);
  });

  it('answers 400 for an unknown kind', async () => {
    const bid = await createBoard();
    const res = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'DELETE',
      headers: T,
      body: JSON.stringify({ fromCardId: 'card_a', toCardId: 'card_b', kind: 'nope' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/boards/:id/cards/:cardId/links', () => {
  it('returns same-board edges as enforced, cross-board edges as advisory, in separate arrays', async () => {
    const bid = await createBoard('Home');
    const otherBid = await createBoard('Away');
    const a = await createCard(bid, 'A');
    const b = await createCard(bid, 'B');
    const away = await createCard(otherBid, 'Away card');

    await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, kind: 'blocks' }),
    });
    // Cross-board edges have no HTTP surface in this task (Task 17a) — seeded directly against
    // Task 16's D1 module, the same way its own test suite does.
    const ext = await addExternalLink(env.DB, 'tnt_links', { from: { boardId: bid, cardId: a }, to: { boardId: otherBid, cardId: away }, kind: 'blocks' });
    expect(ext.ok).toBe(true);

    const res = await SELF.fetch(`${base}/v1/boards/${bid}/cards/${a}/links`, { headers: T });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      links: Array<{ fromCardId: string; toCardId: string; kind: string; enforced: boolean }>;
      externalLinks: Array<{ fromCardId: string; toCardId: string; toBoardId: string; kind: string; enforced: boolean }>;
    };

    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({ fromCardId: a, toCardId: b, kind: 'blocks', enforced: true });

    expect(body.externalLinks).toHaveLength(1);
    expect(body.externalLinks[0]).toMatchObject({ fromCardId: a, toCardId: away, toBoardId: otherBid, kind: 'blocks', enforced: false });
  });

  it('answers empty arrays for a card with no edges', async () => {
    const bid = await createBoard();
    const a = await createCard(bid, 'Lonely');

    const res = await SELF.fetch(`${base}/v1/boards/${bid}/cards/${a}/links`, { headers: T });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { links: unknown[]; externalLinks: unknown[] };
    expect(body.links).toEqual([]);
    expect(body.externalLinks).toEqual([]);
  });
});

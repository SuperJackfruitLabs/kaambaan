import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { listExternalLinksFor } from '../src/db/card-links-external';

/**
 * Task 17d: `toBoardId` on the same `POST|DELETE /v1/boards/:id/links` routes Task 17a built for
 * same-board edges. One route, and the data decides the store — `toBoardId` absent or equal to the
 * path's board stays in the DO (enforced); any other value routes to Task 16's advisory D1 store
 * (`db/card-links-external.ts`), never read on the claim path.
 *
 * The routes and their same-board behaviour are already covered by `links-rest.test.ts`; this file
 * covers only what `toBoardId` adds.
 */

const T = { 'X-Tenant-Id': 'tnt_links_ext', 'Content-Type': 'application/json' };
const base = 'https://api.test';

const STAGES = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_links_ext', 'links-ext', 'Links Ext')`).run();
});

async function createBoard(name = 'Board'): Promise<string> {
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

describe('POST /v1/boards/:id/links with toBoardId', () => {
  it('a cross-board edge lands in D1 (never the DO) and comes back enforced: false', async () => {
    const home = await createBoard('Home');
    const away = await createBoard('Away');
    const a = await createCard(home, 'A');
    const b = await createCard(away, 'B');

    const res = await SELF.fetch(`${base}/v1/boards/${home}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, toBoardId: away, kind: 'blocks' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      link: { fromCardId: string; toCardId: string; toBoardId: string; kind: string; enforced: boolean };
    };
    expect(body.link).toMatchObject({ fromCardId: a, toCardId: b, toBoardId: away, kind: 'blocks', enforced: false });

    // It really landed in D1, not the DO: the DO's own listLinks sees nothing, and the D1 module does.
    expect(await listExternalLinksFor(env.DB, 'tnt_links_ext', a)).toHaveLength(1);
    const listRes = await SELF.fetch(`${base}/v1/boards/${home}/cards/${a}/links`, { headers: T });
    const listBody = (await listRes.json()) as { links: unknown[]; externalLinks: unknown[] };
    expect(listBody.links).toHaveLength(0);
    expect(listBody.externalLinks).toHaveLength(1);
  });

  it('the same request with a matching toBoardId lands in the DO and comes back enforced', async () => {
    const bid = await createBoard();
    const a = await createCard(bid, 'A');
    const b = await createCard(bid, 'B');

    const res = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, toBoardId: bid, kind: 'blocks' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { link: { fromCardId: string; toCardId: string; kind: string; enforced: boolean } };
    expect(body.link).toMatchObject({ fromCardId: a, toCardId: b, kind: 'blocks', enforced: true });

    // And nothing was written to the advisory store.
    expect(await listExternalLinksFor(env.DB, 'tnt_links_ext', a)).toHaveLength(0);
  });

  it("answers 400 PARENT_MUST_BE_SAME_BOARD for kind: 'parent' cross-board", async () => {
    const home = await createBoard('Home2');
    const away = await createBoard('Away2');
    const a = await createCard(home, 'A');
    const b = await createCard(away, 'B');

    const res = await SELF.fetch(`${base}/v1/boards/${home}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, toBoardId: away, kind: 'parent' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PARENT_MUST_BE_SAME_BOARD');

    expect(await listExternalLinksFor(env.DB, 'tnt_links_ext', a)).toHaveLength(0);
  });

  it('answers 404 (not 403) when toBoardId names a board belonging to another tenant', async () => {
    const home = await createBoard('Home3');
    const a = await createCard(home, 'A');

    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_links_ext_foreign', 'links-ext-foreign', 'Foreign')`).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES ('brd_ext_foreign', 'tnt_links_ext_foreign', 'Foreign', '[]')`,
    ).run();

    const res = await SELF.fetch(`${base}/v1/boards/${home}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: 'card_ghost', toBoardId: 'brd_ext_foreign', kind: 'blocks' }),
    });
    expect(res.status, '404, not 403 — a 403 would confirm the board exists').toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FOREIGN_BOARD');
  });
});

/**
 * The shape check on `toBoardId` runs BEFORE the `toBoardId !== boardId` comparison that decides
 * the store. That ordering matters more than it looks: a malformed `toBoardId` that slipped past
 * the check and got compared anyway could, depending on how the comparison and its fallback are
 * written, end up read as "no toBoardId" — same board — and be written to the DO as an ENFORCED
 * edge. An advisory edge that got stored as enforced by accident is exactly the lie this whole
 * design (two stores, two badges) exists to prevent, so every one of these has to answer 400 and
 * write to neither store, not just the ones that look obviously wrong.
 */
describe('POST /v1/boards/:id/links — malformed toBoardId', () => {
  const cases: Array<[string, unknown]> = [
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['a number', 42],
    ['null', null],
    ['an object', { not: 'a board id' }],
  ];

  it.each(cases)('answers 400 for toBoardId as %s, writing to neither store', async (_label, value) => {
    const bid = await createBoard();
    const a = await createCard(bid, 'A');
    const b = await createCard(bid, 'B');

    const res = await SELF.fetch(`${base}/v1/boards/${bid}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, toBoardId: value, kind: 'blocks' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_LINK');

    // Not the DO — no enforced edge was created between a and b.
    const listRes = await SELF.fetch(`${base}/v1/boards/${bid}/cards/${a}/links`, { headers: T });
    const listBody = (await listRes.json()) as { links: unknown[]; externalLinks: unknown[] };
    expect(listBody.links).toHaveLength(0);
    // Not D1 either.
    expect(await listExternalLinksFor(env.DB, 'tnt_links_ext', a)).toHaveLength(0);
  });
});

describe('DELETE /v1/boards/:id/links with toBoardId', () => {
  it('removes a cross-board advisory edge from D1', async () => {
    const home = await createBoard('Home4');
    const away = await createBoard('Away4');
    const a = await createCard(home, 'A');
    const b = await createCard(away, 'B');

    await SELF.fetch(`${base}/v1/boards/${home}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, toBoardId: away, kind: 'blocks' }),
    });
    expect(await listExternalLinksFor(env.DB, 'tnt_links_ext', a)).toHaveLength(1);

    const res = await SELF.fetch(`${base}/v1/boards/${home}/links`, {
      method: 'DELETE',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, toBoardId: away, kind: 'blocks' }),
    });
    expect(res.status).toBe(200);
    expect(await listExternalLinksFor(env.DB, 'tnt_links_ext', a)).toHaveLength(0);
  });

  it("answers 400 PARENT_MUST_BE_SAME_BOARD for kind: 'parent' cross-board, rather than a silent no-op", async () => {
    const home = await createBoard('Home5');
    const away = await createBoard('Away5');
    const a = await createCard(home, 'A');
    const b = await createCard(away, 'B');

    const res = await SELF.fetch(`${base}/v1/boards/${home}/links`, {
      method: 'DELETE',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, toBoardId: away, kind: 'parent' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PARENT_MUST_BE_SAME_BOARD');
  });
});

/**
 * 17b follow-up: the specified tooltip — "Blocked by *Title* on *Board* — not enforced across
 * boards" — needs a title and a board name, and `ExternalLinkRow` only ever carried ids. This is
 * the read that fills them in: a cheap tenant-scoped D1 read for the board name, and a per-row,
 * on-demand cross-DO read for the card title. Neither is on the claim path (the card title read
 * does not even touch `listExternalLinksFor` — it happens in the route, once, after the D1 rows
 * come back), and neither read may fail the whole request: a row whose other board is having a
 * bad day still comes back with its ids, `otherBoardName: null`, `otherCardTitle: null` — the
 * drawer's existing id fallback, not a 500.
 */
describe('GET /v1/boards/:id/cards/:cardId/links — the other end\'s title and board name', () => {
  it('resolves the real card title and board name for a healthy cross-board edge', async () => {
    const home = await createBoard('Home6');
    const away = await createBoard('Away Board Six');
    const a = await createCard(home, 'A');
    const b = await createCard(away, 'The Blocker');

    await SELF.fetch(`${base}/v1/boards/${home}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: b, toBoardId: away, kind: 'blocks' }),
    });

    const res = await SELF.fetch(`${base}/v1/boards/${home}/cards/${a}/links`, { headers: T });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      externalLinks: Array<{ toCardId: string; toBoardId: string; otherCardTitle: string | null; otherBoardName: string | null }>;
    };
    expect(body.externalLinks).toHaveLength(1);
    expect(body.externalLinks[0]).toMatchObject({
      toCardId: b,
      toBoardId: away,
      otherCardTitle: 'The Blocker',
      otherBoardName: 'Away Board Six',
    });
  });

  it('degrades to a null title (never a 500) when the referenced board has not been initialized', async () => {
    const home = await createBoard('Home7');
    const a = await createCard(home, 'A');

    // A real `boards` row — so the board NAME is resolvable — whose Durable Object was never
    // `init()`'d, because it was never created through the board-creation route. This is a
    // realistic version of "the other board's DO is unavailable": `getCardView` on it answers
    // `NOT_INITIALIZED`, not a thrown error, and the route must still turn that into a 200 with a
    // null title rather than letting it become this card's entire blocker list 500ing.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES ('brd_ext_uninit', 'tnt_links_ext', 'Uninitialized Board', '[]')`,
    ).run();

    const post = await SELF.fetch(`${base}/v1/boards/${home}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: 'card_never_existed', toBoardId: 'brd_ext_uninit', kind: 'blocks' }),
    });
    expect(post.status).toBe(201);

    const res = await SELF.fetch(`${base}/v1/boards/${home}/cards/${a}/links`, { headers: T });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      externalLinks: Array<{ toBoardId: string; otherCardTitle: string | null; otherBoardName: string | null }>;
    };
    expect(body.externalLinks).toHaveLength(1);
    // The board name is a plain tenant-scoped D1 read, independent of the DO's own state, so it
    // still resolves even though the DO behind it has never been initialized.
    expect(body.externalLinks[0]!.otherBoardName).toBe('Uninitialized Board');
    expect(body.externalLinks[0]!.otherCardTitle).toBeNull();
  });

  it('degrades to a null title when the referenced card no longer exists on an otherwise healthy board', async () => {
    const home = await createBoard('Home8');
    const away = await createBoard('Away8');
    const a = await createCard(home, 'A');

    await SELF.fetch(`${base}/v1/boards/${home}/links`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ fromCardId: a, toCardId: 'card_deleted_or_never_was', toBoardId: away, kind: 'blocks' }),
    });

    const res = await SELF.fetch(`${base}/v1/boards/${home}/cards/${a}/links`, { headers: T });
    const body = (await res.json()) as { externalLinks: Array<{ otherCardTitle: string | null; otherBoardName: string | null }> };
    expect(body.externalLinks).toHaveLength(1);
    expect(body.externalLinks[0]!.otherBoardName).toBe('Away8');
    expect(body.externalLinks[0]!.otherCardTitle).toBeNull();
  });

  it('never resolves a title or board name for a row pointing at another tenant\'s board, even if one was written directly', async () => {
    const home = await createBoard('Home9');
    const a = await createCard(home, 'A');

    // A second tenant, with a REAL board and a REAL card carrying a title that must never leak.
    const LEAK_TENANT = { 'X-Tenant-Id': 'tnt_links_ext_leak', 'Content-Type': 'application/json' };
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_links_ext_leak', 'links-ext-leak', 'Leak')`).run();
    const leakBoardRes = await SELF.fetch(`${base}/v1/boards`, {
      method: 'POST',
      headers: LEAK_TENANT,
      body: JSON.stringify({ name: 'Secret Board', stages: STAGES }),
    });
    const leakBoardId = ((await leakBoardRes.json()) as { boardId: string }).boardId;
    const leakCardRes = await SELF.fetch(`${base}/v1/boards/${leakBoardId}/cards`, {
      method: 'POST',
      headers: LEAK_TENANT,
      body: JSON.stringify({ title: 'Secret Title', ownerUserId: 'usr_owner' }),
    });
    const leakCardId = ((await leakCardRes.json()) as { card: { id: string } }).card.id;

    // The write route would refuse this as FOREIGN_BOARD — this row simulates one that got into
    // `card_links_external` some other way, so the READ path's own tenant scoping is what is
    // actually on trial here, not the write guard `addExternalLink` already has.
    await env.DB.prepare(
      `INSERT INTO card_links_external (tenant_id, from_board_id, from_card_id, to_board_id, to_card_id, kind) VALUES (?, ?, ?, ?, ?, 'blocks')`,
    ).bind('tnt_links_ext', home, a, leakBoardId, leakCardId).run();

    const res = await SELF.fetch(`${base}/v1/boards/${home}/cards/${a}/links`, { headers: T });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      externalLinks: Array<{ toCardId: string; otherCardTitle: string | null; otherBoardName: string | null }>;
    };
    expect(body.externalLinks).toHaveLength(1);
    expect(body.externalLinks[0]!.toCardId).toBe(leakCardId);
    expect(body.externalLinks[0]!.otherBoardName, 'must not disclose the foreign board\'s name').toBeNull();
    expect(body.externalLinks[0]!.otherCardTitle, 'must not disclose the foreign card\'s title').toBeNull();
  });
});

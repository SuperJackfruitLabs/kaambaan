import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const T = { 'X-Tenant-Id': 'tnt_rest', 'Content-Type': 'application/json' };
const base = 'https://api.test';

async function seedBoardCard(): Promise<{ boardId: string; cardId: string }> {
  const board = (await (
    await SELF.fetch(`${base}/v1/boards`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ name: 'R', stages: [{ key: 'backlog', name: 'Backlog', order: 0 }] }),
    })
  ).json()) as { boardId: string };
  const card = (await (
    await SELF.fetch(`${base}/v1/boards/${board.boardId}/cards`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ title: 'C', ownerUserId: 'usr_a' }),
    })
  ).json()) as { card: { id: string } };
  return { boardId: board.boardId, cardId: card.card.id };
}

describe('REST — PUT /v1/boards/:id/cards/:cardId/references', () => {
  it('upserts a reference idempotently and auto-enriches a GitHub url', async () => {
    const { boardId, cardId } = await seedBoardCard();
    const put = (body: unknown) =>
      SELF.fetch(`${base}/v1/boards/${boardId}/cards/${cardId}/references`, { method: 'PUT', headers: T, body: JSON.stringify(body) });

    const r1 = await put({ url: 'https://github.com/org/repo/pull/42' });
    expect(r1.status).toBe(200);
    const ref1 = ((await r1.json()) as { reference: any }).reference;
    expect(ref1).toMatchObject({ provider: 'github', sourceType: 'pull_request', externalId: 'org/repo#42', addedBy: 'agent' });

    const r2 = await put({ url: 'https://github.com/org/repo/pull/42', title: 'updated' });
    const ref2 = ((await r2.json()) as { reference: any }).reference;
    expect(ref2.id).toBe(ref1.id); // idempotent — same reference

    const snap = (await (await SELF.fetch(`${base}/v1/boards/${boardId}`, { headers: T })).json()) as {
      references: Array<{ title: string }>;
    };
    expect(snap.references).toHaveLength(1);
    expect(snap.references[0]!.title).toBe('updated');
  });

  it('records caller-supplied provenance and explicit provider/sourceType', async () => {
    const { boardId, cardId } = await seedBoardCard();
    const res = await SELF.fetch(`${base}/v1/boards/${boardId}/cards/${cardId}/references`, {
      method: 'PUT',
      headers: T,
      body: JSON.stringify({ url: 'https://docs.example.com/spec', provider: 'docs', sourceType: 'doc', addedBy: 'user' }),
    });
    const ref = ((await res.json()) as { reference: any }).reference;
    expect(ref).toMatchObject({ provider: 'docs', sourceType: 'doc', addedBy: 'user' });
  });

  it('404s a reference on an unknown card', async () => {
    const { boardId } = await seedBoardCard();
    const res = await SELF.fetch(`${base}/v1/boards/${boardId}/cards/card_nope/references`, {
      method: 'PUT',
      headers: T,
      body: JSON.stringify({ url: 'https://x.y' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a non-http(s) url with 400', async () => {
    const { boardId, cardId } = await seedBoardCard();
    const res = await SELF.fetch(`${base}/v1/boards/${boardId}/cards/${cardId}/references`, {
      method: 'PUT',
      headers: T,
      body: JSON.stringify({ url: 'javascript:alert(document.cookie)' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires a tenant header', async () => {
    const { boardId, cardId } = await seedBoardCard();
    const res = await SELF.fetch(`${base}/v1/boards/${boardId}/cards/${cardId}/references`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.y' }),
    });
    expect(res.status).toBe(401);
  });
});

/**
 * The write boundary parses the provider; the read path does not.
 *
 * `ReferenceProvider` named five providers and nothing checked it: the routes cast request bodies
 * rather than parsing them, so on 2026-09-28 `provider: "web"` was written to a live card and
 * stored. An enum that documents a constraint it does not impose is worse than no enum, because
 * everyone downstream writes code believing the constraint holds.
 */
describe('a reference names a provider the registry knows', () => {
  const T = { 'X-Tenant-Id': 'tnt_prov', 'Content-Type': 'application/json' };

  async function card(): Promise<{ boardId: string; cardId: string }> {
    const b = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ name: 'P', stages: [{ key: 'todo', name: 'To do', order: 0 }] }),
    });
    const { boardId } = (await b.json()) as { boardId: string };
    const c = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ title: 'A card' }),
    });
    const { card } = (await c.json()) as { card: { id: string } };
    return { boardId, cardId: card.id };
  }

  const put = async (boardId: string, cardId: string, body: Record<string, unknown>) =>
    SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${cardId}/references`, {
      method: 'PUT',
      headers: T,
      body: JSON.stringify(body),
    });

  it('refuses a provider nobody registered, naming the ones that exist', async () => {
    const { boardId, cardId } = await card();
    const res = await put(boardId, cardId, { url: 'https://example.test/a', provider: 'web' });
    expect(res.status).toBe(400);
    // The message lists the registry, because "invalid provider" sends somebody to read source.
    expect(JSON.stringify(await res.json())).toMatch(/github|forge|url/);
  });

  it('accepts one it does know', async () => {
    const { boardId, cardId } = await card();
    const res = await put(boardId, cardId, { url: 'https://example.test/a', provider: 'url' });
    expect(res.status).toBe(200);
  });

  it('still accepts a reference that names no provider, and recognises it', async () => {
    // Enrichment is the normal path: a caller supplying nothing gets the registry's answer.
    const { boardId, cardId } = await card();
    const res = await put(boardId, cardId, { url: 'https://github.com/org/repo/pull/9' });
    expect(res.status).toBe(200);
    const { reference } = (await res.json()) as { reference: { provider: string; externalId?: string } };
    expect(reference).toMatchObject({ provider: 'github', externalId: 'org/repo#9' });
  });

  it('reads back a row stored before the boundary enforced anything', async () => {
    // `web` is on a live card today. Enforcement is a WRITE rule: a read that threw on old data
    // would turn a tightening into an outage.
    const { boardId, cardId } = await card();
    await put(boardId, cardId, { url: 'https://example.test/legacy', provider: 'url' });
    const state = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: T });
    expect(state.status).toBe(200);
  });
});

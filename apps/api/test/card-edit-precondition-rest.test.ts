import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { BoardInit } from '../src/board/board-do';

/**
 * `PATCH /v1/boards/:id/cards/:cardId` with `expectedUpdatedAt` — the precondition a
 * read-modify-write (`supi edit-card --merge-spec`) sends so it cannot overwrite an edit it never saw.
 */

const PIPE: BoardInit['stages'] = [{ key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' }];
const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

async function seed(tenant: string) {
  const b = await SELF.fetch('https://api.test/v1/boards', { method: 'POST', headers: dev(tenant), body: JSON.stringify({ name: 'P', stages: PIPE }) });
  const boardId = (await b.json<{ boardId: string }>()).boardId;
  const c = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: dev(tenant),
    body: JSON.stringify({ title: 'x', spec: { goal: 'g' } }),
  });
  const card = (await c.json<{ card: { id: string; updatedAt: string | null } }>()).card;
  return { boardId, card };
}

const patch = (tenant: string, boardId: string, cardId: string, body: unknown) =>
  SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${cardId}`, { method: 'PATCH', headers: dev(tenant), body: JSON.stringify(body) });

describe('PATCH /cards/:cardId — expectedUpdatedAt', () => {
  it('writes when the card is unchanged since it was read', async () => {
    const t = 'tnt_pre_rest_ok';
    const { boardId, card } = await seed(t);
    const res = await patch(t, boardId, card.id, { spec: { goal: 'g2' }, expectedUpdatedAt: card.updatedAt });
    expect(res.status).toBe(200);
    expect((await res.json<{ card: { spec: unknown } }>()).card.spec).toEqual({ goal: 'g2' });
  });

  it('answers 409 CARD_CHANGED and writes nothing when the card changed in between', async () => {
    const t = 'tnt_pre_rest_stale';
    const { boardId, card } = await seed(t);
    expect((await patch(t, boardId, card.id, { title: 'someone else' })).status).toBe(200);

    const res = await patch(t, boardId, card.id, { spec: { goal: 'mine' }, expectedUpdatedAt: card.updatedAt });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('CARD_CHANGED');

    const now = await (await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${card.id}`, { headers: dev(t) })).json<{
      card: { title: string; spec: unknown };
    }>();
    expect(now.card).toMatchObject({ title: 'someone else', spec: { goal: 'g' } });
  });

  it('400s an expectedUpdatedAt that is neither null nor a string', async () => {
    const t = 'tnt_pre_rest_bad';
    const { boardId, card } = await seed(t);
    const res = await patch(t, boardId, card.id, { title: 'y', expectedUpdatedAt: 7 });
    expect(res.status).toBe(400);
  });
});

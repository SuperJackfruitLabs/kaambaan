import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

/**
 * `GET /v1/boards/:id/cards/:cardId` — reading one card.
 *
 * The route that `supi card` has always called and that has never existed (#90). The prefix
 * matched `PATCH` and `DELETE` only, so every invocation answered 405 while `supi --help`
 * advertised the command as "one card in full". Its subroutes — `/attempts`, `/activities`,
 * `/estimate` — all serve `GET`; the card itself was the one thing under that prefix you could
 * not read.
 *
 * A CLI that advertises a verb it cannot perform is worse than one that omits it: the failure
 * arrives after you have already decided that is how you will look.
 */

const PIPE: BoardInit['stages'] = [{ key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' }];
const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('BoardDO — getCardView', () => {
  it('returns the same projection the snapshot carries, and 404s an unknown card', async () => {
    await runInDurableObject(stubFor('read-1'), async (board: BoardDO) => {
      await board.init({ id: 'brd_r', tenantId: 'tnt_a', name: 'R', stages: PIPE });
      const c = await board.createCard({ title: 'Readable', ownerUserId: 'usr_a', priority: 3 });
      if (!c.ok) throw new Error('card');

      const got = await board.getCardView(c.value.id);
      if (!got.ok) throw new Error('read failed');
      expect(got.value).toMatchObject({ id: c.value.id, title: 'Readable', priority: 3 });

      // One card and the board snapshot must not disagree about that card.
      const snap = await board.getState();
      expect(got.value).toEqual(snap.cards.find((x) => x.id === c.value.id));

      expect(await board.getCardView('card_missing')).toMatchObject({ ok: false, code: 'CARD_NOT_FOUND' });
    });
  });
});

describe('GET /v1/boards/:id/cards/:cardId', () => {
  async function board(tenant: string) {
    const res = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: dev(tenant),
      body: JSON.stringify({ name: 'Read', stages: PIPE }),
    });
    return (await res.json<{ boardId: string }>()).boardId;
  }

  async function card(tenant: string, boardId: string, title: string) {
    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(tenant),
      body: JSON.stringify({ title }),
    });
    return (await res.json<{ card: { id: string } }>()).card.id;
  }

  it('answers with the card — the 405 this replaces was every invocation', async () => {
    const b = await board('tnt_read');
    const id = await card('tnt_read', b, 'One card in full');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, { headers: dev('tnt_read') });

    expect(res.status).toBe(200);
    expect((await res.json<{ card: { id: string; title: string } }>()).card).toMatchObject({
      id,
      title: 'One card in full',
    });
  });

  it('shapes its body like PATCH does, so one client parses both', async () => {
    const b = await board('tnt_read2');
    const id = await card('tnt_read2', b, 'Shape');

    const read = await (await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, { headers: dev('tnt_read2') })).json<{ card: unknown }>();
    const patched = await (
      await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
        method: 'PATCH',
        headers: dev('tnt_read2'),
        body: JSON.stringify({ title: 'Shape' }),
      })
    ).json<{ card: unknown }>();

    expect(Object.keys(read.card as object).sort()).toEqual(Object.keys(patched.card as object).sort());
  });

  it('404s a card that is not there, rather than 405ing the whole route', async () => {
    const b = await board('tnt_read3');
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/card_nope`, { headers: dev('tnt_read3') });
    expect(res.status).toBe(404);
  });

  it('does not leak a card across tenants', async () => {
    const b = await board('tnt_owner');
    const id = await card('tnt_owner', b, 'Private');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, { headers: dev('tnt_stranger') });
    expect(res.status).not.toBe(200);
  });
});

import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function parentOn(board: BoardDO, name: string): Promise<string> {
  await board.init({ id: `brd_${name}`, tenantId: 'tnt_a', name, stages: STAGES });
  const p = await board.createCard({ title: 'Ship supermd v1', ownerUserId: 'usr_a' });
  if (!p.ok) throw new Error(p.message);
  return p.value.id;
}

describe('splitCard', () => {
  it('creates one child per line and links them all to the parent', async () => {
    await runInDurableObject(stubFor('split-basic'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitbasic');
      const r = await board.splitCard(parentId, ['Write the spec', 'Build the parser'], 'usr_a');
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual(['Write the spec', 'Build the parser']);
      expect(r.value.children.every((c) => c.parentCardId === parentId)).toBe(true);

      const parent = (await board.getState()).cards.find((c) => c.id === parentId)!;
      expect(parent.openChildCount).toBe(2);
    });
  });

  it('strips markdown checkbox syntax, so "- [ ] Foo" becomes "Foo"', async () => {
    await runInDurableObject(stubFor('split-md'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitmd');
      const r = await board.splitCard(
        parentId,
        ['- [ ] Write the spec', '- [x] Build the parser', '* Draft the post', '2. Review it'],
        'usr_a',
      );
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual([
        'Write the spec',
        'Build the parser',
        'Draft the post',
        'Review it',
      ]);
    });
  });

  it('ignores blank lines rather than creating untitled cards', async () => {
    await runInDurableObject(stubFor('split-blank'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitblank');
      const r = await board.splitCard(parentId, ['One', '', '   ', '- [ ] ', 'Two'], 'usr_a');
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual(['One', 'Two']);
    });
  });

  it('refuses more than 20 in one call, and creates none of them', async () => {
    await runInDurableObject(stubFor('split-limit'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitlimit');
      const many = Array.from({ length: 21 }, (_, i) => `Item ${i + 1}`);
      const r = await board.splitCard(parentId, many, 'usr_a');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('TOO_MANY_CHILDREN');
        expect(r.message).toContain('20');
      }
      // A refused split leaves nothing behind: partially creating 20 of 21 would be worse than
      // refusing, because the caller cannot tell which succeeded.
      expect((await board.getState()).cards).toHaveLength(1);
    });
  });

  it('refuses when every line is blank, rather than succeeding with nothing', async () => {
    await runInDurableObject(stubFor('split-empty'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitempty');
      const r = await board.splitCard(parentId, ['', '- [ ] '], 'usr_a');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('NOTHING_TO_SPLIT');
    });
  });

  it('is not idempotent, deliberately: calling twice creates two sets', async () => {
    await runInDurableObject(stubFor('split-twice'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splittwice');
      await board.splitCard(parentId, ['One'], 'usr_a');
      await board.splitCard(parentId, ['One'], 'usr_a');
      // De-duplicating by title would silently drop a legitimately repeated sub-task. The tool
      // description tells the agent to call it once; the UI confirms before a second call.
      const parent = (await board.getState()).cards.find((c) => c.id === parentId)!;
      expect(parent.openChildCount).toBe(2);
    });
  });
});

// The REST door (Task 15, `POST /v1/boards/:id/cards/:cardId/split`): the human/web-app path,
// which reaches the same `splitCard` the MCP tool does but over HTTP, authenticated by the
// `resolveHubUser` fallback every human board route already carries.
const dev = (tenant: string, user?: string) => ({
  'X-Tenant-Id': tenant,
  ...(user ? { 'X-User-Id': user } : {}),
  'Content-Type': 'application/json',
});

async function restBoard(tenant: string, user: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: dev(tenant, user),
    body: JSON.stringify({ name: 'Split REST', stages: [{ key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' }] }),
  });
  return (await res.json<{ boardId: string }>()).boardId;
}

describe('POST /v1/boards/:id/cards/:cardId/split — REST', () => {
  it('creates children and returns them, 201', async () => {
    const tenant = 'tnt_split_rest';
    const boardId = await restBoard(tenant, 'usr_r');
    const created = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ title: 'Parent' }),
    });
    const { card } = await created.json<{ card: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${card.id}/split`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ titles: ['- [ ] Write the spec', 'Build the parser'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ children: Array<{ title: string; parentCardId: string }> }>();
    expect(body.children.map((c) => c.title)).toEqual(['Write the spec', 'Build the parser']);
    expect(body.children.every((c) => c.parentCardId === card.id)).toBe(true);
  });

  it('answers 400 for a non-array titles field, rather than reaching the DO', async () => {
    const tenant = 'tnt_split_rest2';
    const boardId = await restBoard(tenant, 'usr_r');
    const created = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ title: 'Parent' }),
    });
    const { card } = await created.json<{ card: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${card.id}/split`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ titles: 'not an array' }),
    });
    expect(res.status).toBe(400);
  });

  it('answers 400 for TOO_MANY_CHILDREN, the DO business refusal mapped over REST', async () => {
    const tenant = 'tnt_split_rest3';
    const boardId = await restBoard(tenant, 'usr_r');
    const created = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ title: 'Parent' }),
    });
    const { card } = await created.json<{ card: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${card.id}/split`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ titles: Array.from({ length: 21 }, (_, i) => `Item ${i + 1}`) }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('TOO_MANY_CHILDREN');
  });
});

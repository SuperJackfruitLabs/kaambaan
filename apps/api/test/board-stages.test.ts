import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

/**
 * The audit's "written once, then fixed forever" headline: a board's pipeline was set in `init`
 * and there was no update route and no DO method, so not one stage field could be changed
 * afterwards. A mistyped stage name, or a WIP limit one too low, cost the board and every card
 * on it.
 */

const PIPE: BoardInit['stages'] = [
  { key: 'todo', name: 'To do', order: 0 },
  { key: 'doing', name: 'Doing', order: 1, ownerKind: 'capability', owner: 'research' },
  { key: 'done', name: 'Done', order: 2 },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('BoardDO — the pipeline can be reworked', () => {
  it('retitles, retunes and reorders every field except the key', async () => {
    await runInDurableObject(stubFor('st-edit'), async (board: BoardDO) => {
      await board.init({ id: 'brd_st1', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      const r = await board.setStages([
        { key: 'todo', name: 'Backlog', order: 1 },
        { key: 'doing', name: 'In progress', order: 0, ownerKind: 'capability', owner: 'code', wipLimit: 2, gate: 'approval' },
        { key: 'done', name: 'Done', order: 2 },
      ]);
      expect(r.ok).toBe(true);

      const stages = (await board.getState()).stages;
      expect(stages.map((s) => s.key)).toEqual(['doing', 'todo', 'done']); // reordered
      expect(stages[0]!.name).toBe('In progress');
      expect(stages[0]!.owner).toBe('code');
      expect(stages[0]!.wipLimit).toBe(2);
      expect(stages[0]!.gate).toBe('approval');
    });
  });

  it('adds a stage without disturbing the cards already on the board', async () => {
    await runInDurableObject(stubFor('st-add'), async (board: BoardDO) => {
      await board.init({ id: 'brd_st2', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      const card = await board.createCard({ title: 'x', ownerUserId: 'usr_a' });
      expect(card.ok).toBe(true);

      await board.setStages([...PIPE, { key: 'review', name: 'Review', order: 3, gate: 'approval' }]);
      const snap = await board.getState();
      expect(snap.stages).toHaveLength(4);
      expect(snap.cards[0]!.currentStageKey).toBe('todo'); // untouched
    });
  });

  it('refuses to remove a stage that still holds cards', async () => {
    await runInDurableObject(stubFor('st-busy'), async (board: BoardDO) => {
      await board.init({ id: 'brd_st3', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      await board.createCard({ title: 'x', ownerUserId: 'usr_a' }); // lands in `todo`

      const r = await board.setStages([{ key: 'done', name: 'Done', order: 0 }]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('STAGE_NOT_EMPTY');
        expect(r.message).toContain('todo');
      }
      // Refused whole: the payload also dropped `doing`, and nothing was applied.
      expect((await board.getState()).stages).toHaveLength(3);
    });
  });

  it('removes an empty stage', async () => {
    await runInDurableObject(stubFor('st-empty'), async (board: BoardDO) => {
      await board.init({ id: 'brd_st4', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      const r = await board.setStages(PIPE.filter((s) => s.key !== 'doing'));
      expect(r.ok).toBe(true);
      expect((await board.getState()).stages.map((s) => s.key)).toEqual(['todo', 'done']);
    });
  });

  it('refuses a pipeline that is not one', async () => {
    await runInDurableObject(stubFor('st-bad'), async (board: BoardDO) => {
      await board.init({ id: 'brd_st5', tenantId: 'tnt_a', name: 'S', stages: PIPE });

      const empty = await board.setStages([]);
      expect(empty.ok).toBe(false);

      const dup = await board.setStages([
        { key: 'todo', name: 'A', order: 0 },
        { key: 'todo', name: 'B', order: 1 },
      ]);
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.code).toBe('INVALID_STAGES');

      const unnamed = await board.setStages([{ key: 'todo', name: '  ', order: 0 }]);
      expect(unnamed.ok).toBe(false);

      const badWip = await board.setStages([{ key: 'todo', name: 'A', order: 0, wipLimit: 0 }]);
      expect(badWip.ok).toBe(false);

      expect((await board.getState()).stages).toHaveLength(3); // nothing landed
    });
  });
});

describe('REST — PUT /v1/boards/:id/stages', () => {
  const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

  async function makeBoard(tenant: string): Promise<string> {
    const res = await SELF.fetch('https://api.test/v1/boards', { method: 'POST', headers: dev(tenant), body: JSON.stringify({ name: 'B', stages: PIPE }) });
    return (await res.json<{ boardId: string }>()).boardId;
  }

  it('applies the change and keeps the catalog copy in step', async () => {
    const t = 'tnt_stages';
    const boardId = await makeBoard(t);
    const next = [...PIPE, { key: 'review', name: 'Review', order: 3 }];

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/stages`, { method: 'PUT', headers: dev(t), body: JSON.stringify({ stages: next }) });
    expect(res.status).toBe(200);
    expect((await res.json<{ stages: unknown[] }>()).stages).toHaveLength(4);

    // The catalog copy describes the board without waking its DO, so a stale copy is a board that
    // describes itself wrongly.
    const row = await env.DB.prepare(`SELECT stages_json FROM boards WHERE id = ?`).bind(boardId).first<{ stages_json: string }>();
    expect(JSON.parse(row!.stages_json)).toHaveLength(4);
  });

  it('leaves the catalog untouched when the DO refuses', async () => {
    const t = 'tnt_stages_refuse';
    const boardId = await makeBoard(t);
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: dev(t), body: JSON.stringify({ title: 'x' }) });

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/stages`, {
      method: 'PUT',
      headers: dev(t),
      body: JSON.stringify({ stages: [{ key: 'done', name: 'Done', order: 0 }] }),
    });
    expect(res.status).toBe(409);

    const row = await env.DB.prepare(`SELECT stages_json FROM boards WHERE id = ?`).bind(boardId).first<{ stages_json: string }>();
    expect(JSON.parse(row!.stages_json)).toHaveLength(3);
  });
});

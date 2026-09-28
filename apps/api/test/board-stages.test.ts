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

/**
 * A stage's standing rule (docs/05) — the text handed to every agent that claims a card there.
 *
 * It reached agents before the field was declared, because `setStages` stores what it is given
 * and `stages()` parses it straight back. These pin the parts that were never true by accident:
 * that it survives a rework, and that the length cap in the contract is enforced where the write
 * happens rather than only where a client happens to validate.
 */
describe('BoardDO — a stage carries its own instructions', () => {
  const RULE = "Push to the repository's PRIMARY remote, never to GitHub directly.";

  it('keeps a stage rule across a rework, and only on the stage that has one', async () => {
    await runInDurableObject(stubFor('st-instructions'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sti', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      const r = await board.setStages([
        { key: 'todo', name: 'To do', order: 0 },
        { key: 'doing', name: 'Doing', order: 1, ownerKind: 'capability', owner: 'code', instructions: RULE },
        { key: 'done', name: 'Done', order: 2 },
      ]);
      expect(r.ok).toBe(true);

      const stages = (await board.getState()).stages;
      expect(stages.find((s) => s.key === 'doing')!.instructions).toBe(RULE);
      // A rule belongs to one stage. Leaking onto its neighbours would govern work it
      // was never written for, which is worse than not being carried at all.
      expect(stages.find((s) => s.key === 'todo')!.instructions).toBeUndefined();
      expect(stages.find((s) => s.key === 'done')!.instructions).toBeUndefined();
    });
  });

  it('refuses a rule too long to be one', async () => {
    await runInDurableObject(stubFor('st-instructions-long'), async (board: BoardDO) => {
      await board.init({ id: 'brd_stl', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      const r = await board.setStages([
        { key: 'todo', name: 'To do', order: 0 },
        { key: 'doing', name: 'Doing', order: 1, instructions: 'x'.repeat(4001) },
        { key: 'done', name: 'Done', order: 2 },
      ]);
      // The cap lives in the contract, but the route casts rather than parses — so a cap
      // enforced only there is a cap nothing enforces.
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_STAGES');
    });
  });

  it('refuses an empty rule rather than storing a heading with nothing under it', async () => {
    await runInDurableObject(stubFor('st-instructions-blank'), async (board: BoardDO) => {
      await board.init({ id: 'brd_stb', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      const r = await board.setStages([
        { key: 'todo', name: 'To do', order: 0 },
        { key: 'doing', name: 'Doing', order: 1, instructions: '   ' },
        { key: 'done', name: 'Done', order: 2 },
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_STAGES');
    });
  });
});

/**
 * Patching ONE stage.
 *
 * `setStages` replaces the pipeline, so changing one field meant reading every stage, mutating
 * one, and writing them all back — four times in one afternoon while configuring one board, and
 * every one of those writes would have discarded a concurrent edit to a stage it never touched.
 */
describe('BoardDO — one stage can be changed without rewriting the pipeline', () => {
  const RULE = 'Push to the PRIMARY remote, never to GitHub directly.';

  it('changes only the named stage, and only the fields given', async () => {
    await runInDurableObject(stubFor('st-patch'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sp', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      const r = await board.updateStage('doing', { instructions: RULE });
      expect(r.ok).toBe(true);

      const stages = (await board.getState()).stages;
      const doing = stages.find((s) => s.key === 'doing')!;
      expect(doing.instructions).toBe(RULE);
      // The fields not named are untouched — a patch that silently dropped `owner` would
      // unstaff a lane, and nothing on the board would say why it stopped being claimed.
      expect(doing.owner).toBe('research');
      expect(doing.name).toBe('Doing');
      expect(stages.map((s) => s.key)).toEqual(['todo', 'doing', 'done']);
      expect(stages.find((s) => s.key === 'todo')!.instructions).toBeUndefined();
    });
  });

  it('refuses a stage that is not on the board, rather than creating one', async () => {
    await runInDurableObject(stubFor('st-patch-missing'), async (board: BoardDO) => {
      await board.init({ id: 'brd_spm', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      const r = await board.updateStage('nope', { instructions: RULE });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('UNKNOWN_STAGE');
    });
  });

  it('holds a patched rule to the same limits a replaced one meets', async () => {
    // The validation lives in one place for both writes. Two copies drift, and the copy that
    // drifts is the one nobody is looking at.
    await runInDurableObject(stubFor('st-patch-limits'), async (board: BoardDO) => {
      await board.init({ id: 'brd_spl', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      const long = await board.updateStage('doing', { instructions: 'x'.repeat(4001) });
      expect(long.ok).toBe(false);
      const blank = await board.updateStage('doing', { instructions: '   ' });
      expect(blank.ok).toBe(false);
    });
  });

  it('clears a rule when asked with null, which is not the same as omitting it', async () => {
    await runInDurableObject(stubFor('st-patch-clear'), async (board: BoardDO) => {
      await board.init({ id: 'brd_spc', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      await board.updateStage('doing', { instructions: RULE });
      await board.updateStage('doing', { name: 'In progress' });
      expect((await board.getState()).stages.find((s) => s.key === 'doing')!.instructions).toBe(RULE);

      await board.updateStage('doing', { instructions: null });
      expect((await board.getState()).stages.find((s) => s.key === 'doing')!.instructions).toBeUndefined();
    });
  });

  it('normalises a capability owner the way the whole-pipeline write does', async () => {
    await runInDurableObject(stubFor('st-patch-norm'), async (board: BoardDO) => {
      await board.init({ id: 'brd_spn', tenantId: 'tnt_a', name: 'S', stages: PIPE });
      await board.updateStage('doing', { owner: 'Code Review' });
      expect((await board.getState()).stages.find((s) => s.key === 'doing')!.owner).toBe('code-review');
    });
  });
});

describe('PATCH /v1/boards/:id/stages/:stageKey', () => {
  const dev = { 'X-Tenant-Id': 'tnt_patch', 'Content-Type': 'application/json' };

  async function board(): Promise<string> {
    const res = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: dev,
      body: JSON.stringify({ name: 'P', stages: PIPE }),
    });
    return ((await res.json()) as { boardId: string }).boardId;
  }

  it('sets a stage rule without the caller holding the rest of the pipeline', async () => {
    const id = await board();
    const res = await SELF.fetch(`https://api.test/v1/boards/${id}/stages/doing`, {
      method: 'PATCH',
      headers: dev,
      body: JSON.stringify({ instructions: 'Push to the PRIMARY remote.' }),
    });
    expect(res.status).toBe(200);

    const state = (await (await SELF.fetch(`https://api.test/v1/boards/${id}`, { headers: dev })).json()) as {
      stages: Array<{ key: string; instructions?: string; owner?: string }>;
    };
    expect(state.stages.find((s) => s.key === 'doing')!.instructions).toBe('Push to the PRIMARY remote.');
    expect(state.stages.find((s) => s.key === 'doing')!.owner).toBe('research');
    expect(state.stages.map((s) => s.key)).toEqual(['todo', 'doing', 'done']);
  });

  it('refuses `key` and `order` by name rather than ignoring them', async () => {
    // Dropping them silently would answer 200 for a rename that did not happen, which is the
    // worst of the three options: the caller believes the board changed.
    const id = await board();
    for (const body of [{ key: 'renamed' }, { order: 0 }]) {
      const res = await SELF.fetch(`https://api.test/v1/boards/${id}/stages/doing`, {
        method: 'PATCH',
        headers: dev,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/not patchable/);
    }
  });

  it('answers 404 for a stage the board does not have', async () => {
    const id = await board();
    const res = await SELF.fetch(`https://api.test/v1/boards/${id}/stages/absent`, {
      method: 'PATCH',
      headers: dev,
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });
});

import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit, type CardView } from '../src/board/board-do';

const STAGES = [
  { key: 'done', name: 'Done', order: 2 },
  { key: 'backlog', name: 'Backlog', order: 0 },
  { key: 'doing', name: 'Doing', order: 1, wipLimit: 1 },
];

const boardInit = (id = 'brd_test'): BoardInit => ({
  id,
  tenantId: 'tnt_a',
  name: 'Test board',
  stages: STAGES,
});

function instanceFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function mustCreate(board: BoardDO, title: string): Promise<CardView> {
  const r = await board.createCard({ title, ownerUserId: 'usr_a' });
  if (!r.ok) throw new Error(`createCard failed: ${r.message}`);
  return r.value;
}

describe('BoardDO', () => {
  it('init sorts stages by order and is idempotent', async () => {
    await runInDurableObject(instanceFor('b-init'), async (board: BoardDO) => {
      const snap = await board.init(boardInit());
      expect(snap.stages.map((s) => s.key)).toEqual(['backlog', 'doing', 'done']);
      const again = await board.init(boardInit());
      expect(again.boardId).toBe('brd_test');
    });
  });

  it('createCard places the card in the first stage as submitted', async () => {
    await runInDurableObject(instanceFor('b-create'), async (board: BoardDO) => {
      await board.init(boardInit());
      const card = await mustCreate(board, 'Summarize reports');
      expect(card.currentStageKey).toBe('backlog');
      expect(card.state).toBe('submitted');
      expect(card.id).toMatch(/^card_/);
    });
  });

  it('moveCard advances a card and records an event', async () => {
    await runInDurableObject(instanceFor('b-move'), async (board: BoardDO) => {
      await board.init(boardInit());
      const card = await mustCreate(board, 'A');
      const moved = await board.moveCard(card.id, 'doing', 'usr_a');
      expect(moved.ok).toBe(true);
      if (moved.ok) expect(moved.value.currentStageKey).toBe('doing');
      const events = await board.getEvents();
      expect(events.map((e) => e.type)).toEqual(['board.initialized', 'card.created', 'card.moved']);
    });
  });

  it('enforces the target stage WIP limit', async () => {
    await runInDurableObject(instanceFor('b-wip'), async (board: BoardDO) => {
      await board.init(boardInit());
      const c1 = await mustCreate(board, 'A');
      const c2 = await mustCreate(board, 'B');
      expect((await board.moveCard(c1.id, 'doing')).ok).toBe(true); // fills WIP (limit 1)
      const blocked = await board.moveCard(c2.id, 'doing');
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.code).toBe('WIP_LIMIT');
    });
  });

  it('rejects moves to an unknown stage', async () => {
    await runInDurableObject(instanceFor('b-unknown'), async (board: BoardDO) => {
      await board.init(boardInit());
      const card = await mustCreate(board, 'A');
      const r = await board.moveCard(card.id, 'nope');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('UNKNOWN_STAGE');
    });
  });

  it('rejects moving a card that does not exist', async () => {
    await runInDurableObject(instanceFor('b-missing'), async (board: BoardDO) => {
      await board.init(boardInit());
      const r = await board.moveCard('card_nope', 'doing');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('CARD_NOT_FOUND');
    });
  });

  it('refuses to create a card before init', async () => {
    await runInDurableObject(instanceFor('b-noinit'), async (board: BoardDO) => {
      const r = await board.createCard({ title: 'A', ownerUserId: 'u' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('NOT_INITIALIZED');
    });
  });

  it('moving to the current stage is a no-op', async () => {
    await runInDurableObject(instanceFor('b-noop'), async (board: BoardDO) => {
      await board.init(boardInit());
      const card = await mustCreate(board, 'A');
      const same = await board.moveCard(card.id, 'backlog');
      expect(same.ok).toBe(true);
      if (same.ok) expect(same.value.currentStageKey).toBe('backlog');
    });
  });
});

/**
 * `DELETE /v1/boards/:id` removed the catalog row and nothing else, so the Durable Object and
 * every card, run, gate and reference it held survived — unreachable through any route,
 * undeleted, and still billing storage. A person who deleted a board had every reason to believe
 * its contents were gone.
 */
describe('deleting a board takes its contents with it', () => {
  const T = { 'X-Tenant-Id': 'tnt_destroy', 'Content-Type': 'application/json' };

  it('leaves an uninitialised board behind, not a populated one', async () => {
    const made = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ name: 'D', stages: [{ key: 'todo', name: 'To do', order: 0 }] }),
    });
    const { boardId } = await made.json<{ boardId: string }>();
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: T, body: JSON.stringify({ title: 'Doomed' }) });

    expect((await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: T })).status).toBe(200);

    const gone = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { method: 'DELETE', headers: T });
    expect(gone.status).toBe(204);

    // The catalog no longer lists it…
    const { boards } = await (await SELF.fetch('https://api.test/v1/boards', { headers: T })).json<{ boards: Array<{ id: string }> }>();
    expect(boards.map((b) => b.id)).not.toContain(boardId);

    // …and the DO behind it holds nothing. Woken by id, it answers as a board that was never made.
    const after = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: T });
    expect(after.status).toBe(404);
  });
});

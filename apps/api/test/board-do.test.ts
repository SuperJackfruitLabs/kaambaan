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

  /**
   * Whole-branch review, Critical: migration 0012 gave `boards(id)` its first (and only) foreign
   * key — `card_links_external.from_board_id`/`to_board_id`, no `ON DELETE` clause — and
   * `deleteBoard` (`db/catalog.ts`) was still the bare `DELETE FROM boards` written when nothing
   * referenced that table. The route destroys the Durable Object FIRST (deliberately, so a D1
   * failure leaves the board visibly undeleted rather than vanished) — but a board with any
   * cross-board advisory edge now makes the SECOND half fail on the FK, leaving the irreversible
   * half done and the recoverable half not: a board gone from its own Durable Object, still listed
   * in the catalog, and un-deletable on every retry (the DO is already empty, so nothing about a
   * second attempt is any different).
   *
   * Confirmed by directly reproducing that exact end state against the pre-fix code before writing
   * the fix: DELETE answered 500 (`D1_ERROR: FOREIGN KEY constraint failed`), the board was still
   * in `GET /v1/boards`, and its own snapshot already answered 404 — listed, but gone.
   */
  it('deletes cleanly with a cross-board advisory edge in EACH direction, leaving no orphan', async () => {
    const T2 = { 'X-Tenant-Id': 'tnt_destroy2', 'Content-Type': 'application/json' };
    // `card_links_external.tenant_id` FKs to `tenants(id)` (unlike `boards.tenant_id`, which this
    // suite's other tests already create boards without) — required so `addExternalLink` itself
    // does not 500 on an unrelated FK before this test ever reaches the one under test.
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_destroy2', 'destroy2', 'Destroy2')`).run();

    const STAGES2 = [{ key: 'todo', name: 'To do', order: 0 }];
    const mkBoard = async (name: string) => {
      const res = await SELF.fetch('https://api.test/v1/boards', { method: 'POST', headers: T2, body: JSON.stringify({ name, stages: STAGES2 }) });
      return (await res.json<{ boardId: string }>()).boardId;
    };
    const mkCard = async (boardId: string, title: string) => {
      const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: T2, body: JSON.stringify({ title }) });
      return (await res.json<{ card: { id: string } }>()).card.id;
    };

    const home = await mkBoard('Home');
    const away = await mkBoard('Away');
    const h = await mkCard(home, 'H');
    const a = await mkCard(away, 'A');

    // An edge naming `home` as the SOURCE (from_board_id = home)…
    const out = await SELF.fetch(`https://api.test/v1/boards/${home}/links`, {
      method: 'POST',
      headers: T2,
      body: JSON.stringify({ fromCardId: h, toCardId: a, toBoardId: away, kind: 'blocks' }),
    });
    expect(out.status).toBe(201);
    // …and one naming `home` as the TARGET (to_board_id = home) — the FK fires on either column,
    // so a fix that only cleans one direction still leaves the board undeletable from the other.
    const inn = await SELF.fetch(`https://api.test/v1/boards/${away}/links`, {
      method: 'POST',
      headers: T2,
      body: JSON.stringify({ fromCardId: a, toCardId: h, toBoardId: home, kind: 'blocks' }),
    });
    expect(inn.status).toBe(201);

    const del = await SELF.fetch(`https://api.test/v1/boards/${home}`, { method: 'DELETE', headers: T2 });

    const { boards } = await (await SELF.fetch('https://api.test/v1/boards', { headers: T2 })).json<{ boards: Array<{ id: string }> }>();
    const snapshotStatus = (await SELF.fetch(`https://api.test/v1/boards/${home}`, { headers: T2 })).status;
    const orphanedRows = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM card_links_external WHERE from_board_id = ? OR to_board_id = ?`)
      .bind(home, home)
      .first<{ n: number }>();

    // One assertion over the whole observable end state, not the thrown error alone: a delete
    // that "worked" by silently leaving the board listed, or by leaving a dangling advisory row
    // behind, is just a quieter version of the same bug.
    expect({
      deleteStatus: del.status,
      stillListed: boards.map((b) => b.id).includes(home),
      snapshotStatusAfterDelete: snapshotStatus,
      orphanedExternalLinkRows: orphanedRows?.n ?? 0,
    }).toEqual({
      deleteStatus: 204,
      stillListed: false,
      snapshotStatusAfterDelete: 404,
      orphanedExternalLinkRows: 0,
    });

    // The OTHER board's own advisory rows are gone too — deleting home must not leave away
    // pointing at a card_links_external row for a board that no longer exists.
    const awayRows = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM card_links_external WHERE from_board_id = ? OR to_board_id = ?`)
      .bind(away, away)
      .first<{ n: number }>();
    expect(awayRows?.n ?? 0).toBe(0);
  });
});

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { createProject, computeRollup } from '../src/db/projects';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

// Tenant-prefixed, unlike most of this suite's `stubFor` helpers (which address a DO by its bare
// name because nothing else in those files ever has to find the same instance a different route
// would). This one does: `computeRollup` reaches each board through the real `boardStub(env,
// tenantId, boardId)` (`src/board/stub.ts`), which hashes `${tenantId}:${boardId}` — so seeding
// and reading have to agree on that same address or the rollup would silently sum a board nobody
// seeded. Same convention `agent-run-identity.test.ts`/`control-pair-claim.test.ts` use for the
// same reason.
function stubFor(name: string, tenantId = 'tnt_r'): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(`${tenantId}:brd_${name}`)) as unknown as DurableObjectStub<BoardDO>;
}

/** Register a board in the catalog so `listAllBoards` finds it, then seed it into the project. */
async function seedBoard(name: string, projectId: string, titles: string[], tenantId = 'tnt_r'): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES (?, ?, ?, '[]')`)
    .bind(`brd_${name}`, tenantId, name)
    .run();
  await runInDurableObject(stubFor(name, tenantId), async (board: BoardDO) => {
    await board.init({ id: `brd_${name}`, tenantId, name, stages: STAGES });
    for (const title of titles) {
      const c = await board.createCard({ title, ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error(c.message);
      await board.updateCard(c.value.id, { projectId });
    }
  });
}

// A SEPARATE tenant for the two tests that deliberately register a catalog row for a board whose
// DO is never initialized (`brd_ghost*`). Durable, not merely ordered: the first draft of this
// file put that board under `tnt_r` and relied on test declaration order (placed last) to keep it
// from poisoning every earlier `partial: false` assertion — real D1 storage in this suite is
// isolated per test FILE, not per test, so any `tnt_r` test appended later would silently inherit
// `partial: true` for a reason that has nothing to do with what it's checking. A dedicated tenant
// removes the ordering requirement entirely, rather than documenting it.
const GHOST_TENANT = 'tnt_r_ghost';

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_r', 'rollup', 'Rollup')`).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, 'rollup-ghost', 'Rollup Ghost')`).bind(GHOST_TENANT).run();
});

describe('project rollup', () => {
  it('counts cards across two boards', async () => {
    const p = await createProject(env.DB, 'tnt_r', { name: 'across' });
    await seedBoard('rollA', p.id, ['One', 'Two']);
    await seedBoard('rollB', p.id, ['Three']);
    const r = await computeRollup(env.DB, env, 'tnt_r', p.id);
    expect(r.cardsTotal).toBe(3);
    expect(r.partial).toBe(false);
  });

  it('counts a card done only when RESOLVED, not merely terminal', async () => {
    const p = await createProject(env.DB, 'tnt_r', { name: 'resolved-only' });
    await seedBoard('rollC', p.id, ['Will fail', 'Will finish']);

    await runInDurableObject(stubFor('rollC'), async (board: BoardDO) => {
      const first = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!first.claimed) throw new Error('expected a claim');
      await board.fail({ runId: first.runId, leaseEpoch: first.leaseEpoch, reason: 'nope' });

      const second = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!second.claimed) throw new Error('expected a second claim');
      await board.complete({
        runId: second.runId,
        leaseEpoch: second.leaseEpoch,
        handoff: { summary: 'ok' },
      });
    });

    const r = await computeRollup(env.DB, env, 'tnt_r', p.id);
    expect(r.cardsTotal).toBe(2);
    // The failed card is terminal but NOT done. Counting it as done would report a project
    // complete while half its work failed — the same trap as Task 12's isResolved/isTerminal.
    expect(r.cardsDone).toBe(1);
  });

  it('records computed_at, and caches it', async () => {
    const p = await createProject(env.DB, 'tnt_r', { name: 'stamped' });
    await seedBoard('rollD', p.id, ['One']);
    const before = Date.now();
    const r = await computeRollup(env.DB, env, 'tnt_r', p.id);
    expect(new Date(r.computedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const cached = await env.DB.prepare(
      `SELECT computed_at FROM project_rollups WHERE project_id = ?`,
    )
      .bind(p.id)
      .first<{ computed_at: string }>();
    expect(cached?.computed_at).toBe(r.computedAt);
  });

  it('excludes another tenant\'s board even when its cards carry this project\'s id, and stays non-partial', async () => {
    // `listAllBoards` (`db/catalog.ts`) has no tenant filter of its own — it's the cron's global
    // walk across every tenant in the deployment. `computeRollup` is what keeps the fan-out inside
    // one tenant, by filtering BEFORE a single board stub is touched. A missing (or broken) filter
    // here produces no error and no refusal — just a total that is silently too large, which is
    // exactly the failure this test exists to catch: the other tenant's cards carry the SAME
    // project id as this tenant's project, so nothing but the tenant filter can tell them apart.
    //
    const other = 'tnt_r_leak';
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, ?)`).bind(other, 'rollup-leak', 'Rollup Leak').run();

    const p = await createProject(env.DB, 'tnt_r', { name: 'isolation' });

    // This tenant's own board: one card, with cost, carrying `p.id`.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES ('brd_rollIso', 'tnt_r', 'rollIso', '[]')`,
    ).run();
    await runInDurableObject(stubFor('rollIso'), async (board: BoardDO) => {
      await board.init({ id: 'brd_rollIso', tenantId: 'tnt_r', name: 'rollIso', stages: STAGES });
      const c = await board.createCard({ title: 'Mine', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error(c.message);
      await board.updateCard(c.value.id, { projectId: p.id });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      await board.postActivity({ runId: claim.runId, leaseEpoch: claim.leaseEpoch, type: 'action', usage: { costUsd: 1 } });
    });

    // ANOTHER tenant's board, carrying the SAME project id on its cards — the DO has no way to
    // check this (projects are in D1), so nothing stops a card in a different tenant's board from
    // naming it. Two cards with cost, so a leak would be unmissable rather than a rounding error.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES ('brd_leak', ?, 'leak', '[]')`,
    )
      .bind(other)
      .run();
    const leakStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`${other}:brd_leak`)) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(leakStub, async (board: BoardDO) => {
      await board.init({ id: 'brd_leak', tenantId: other, name: 'leak', stages: STAGES });
      for (const title of ['Not mine 1', 'Not mine 2']) {
        const c = await board.createCard({ title, ownerUserId: 'usr_x' });
        if (!c.ok) throw new Error(c.message);
        await board.updateCard(c.value.id, { projectId: p.id }); // same project id, different tenant
      }
      const claim = await board.claim({ agentId: 'agt_x', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      await board.postActivity({ runId: claim.runId, leaseEpoch: claim.leaseEpoch, type: 'action', usage: { costUsd: 50 } });
    });

    const r = await computeRollup(env.DB, env, 'tnt_r', p.id);
    // Only the one card on tnt_r's own board. If the tenant filter in `computeRollup` were
    // missing, this would read 3 cards and $51 instead.
    expect(r.cardsTotal).toBe(1);
    expect(r.costUsd).toBe(1);
    // The other tenant's board is out of SCOPE, not unanswered — conflating the two would make a
    // correctly-filtered rollup look exactly like a degraded one.
    expect(r.partial).toBe(false);
    expect(r.boardsUnanswered).toBe(0);
  });

  it('survives one board failing to answer, and says the rollup is partial', async () => {
    const p = await createProject(env.DB, GHOST_TENANT, { name: 'partial' });
    await seedBoard('rollE', p.id, ['One'], GHOST_TENANT);
    // A catalog row whose Durable Object was never initialised: `projectSummary` answers
    // `{ ok: false, code: 'NOT_INITIALIZED' }` on it (a `Result`, not a thrown exception — see
    // `projectSummary`'s own comment in board-do.ts for why).
    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES ('brd_ghost', ?, 'ghost', '[]')`,
    )
      .bind(GHOST_TENANT)
      .run();

    const r = await computeRollup(env.DB, env, GHOST_TENANT, p.id);
    // It must NOT throw, and must NOT report a confident total.
    expect(r.partial).toBe(true);
    expect(r.boardsUnanswered).toBe(1);
    expect(r.cardsTotal).toBe(1);
  });

  it('logs the board id and reason when a board does not answer, rather than an anonymous count', async () => {
    // `boardsUnanswered` collapsing `{ ok: false }` and a genuine throw into "one board did not
    // answer" is the right abstraction (nothing downstream needs to tell them apart) — but a real
    // failure with no trace anywhere is exactly the failure mode `scheduled()`'s own sweep arm
    // comment (`index.ts`) already names. This asserts the trace exists, not just the count.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = await createProject(env.DB, GHOST_TENANT, { name: 'logged' });
      await env.DB.prepare(
        `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES ('brd_ghost_logged', ?, 'ghost-logged', '[]')`,
      )
        .bind(GHOST_TENANT)
        .run();

      await computeRollup(env.DB, env, GHOST_TENANT, p.id);

      // Not `toHaveBeenCalledTimes(1)` — `GHOST_TENANT`'s catalog also carries `brd_ghost` from
      // the test above (same tenant, and D1 storage here is isolated per FILE, not per test), so
      // this project's own walk logs that board too. Asserted by content instead: THIS board's
      // failure left a trace naming it and why, regardless of how many others also failed.
      const logged = spy.mock.calls.some(
        ([message]) => String(message).includes('brd_ghost_logged') && String(message).includes('NOT_INITIALIZED'),
      );
      expect(logged).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
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
function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(`tnt_r:brd_${name}`)) as unknown as DurableObjectStub<BoardDO>;
}

/** Register a board in the catalog so `listAllBoards` finds it, then seed it into the project. */
async function seedBoard(name: string, projectId: string, titles: string[]): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES (?, 'tnt_r', ?, '[]')`,
  )
    .bind(`brd_${name}`, name)
    .run();
  await runInDurableObject(stubFor(name), async (board: BoardDO) => {
    await board.init({ id: `brd_${name}`, tenantId: 'tnt_r', name, stages: STAGES });
    for (const title of titles) {
      const c = await board.createCard({ title, ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error(c.message);
      await board.updateCard(c.value.id, { projectId });
    }
  });
}

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_r', 'rollup', 'Rollup')`).run();
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

  it('survives one board failing to answer, and says the rollup is partial', async () => {
    const p = await createProject(env.DB, 'tnt_r', { name: 'partial' });
    await seedBoard('rollE', p.id, ['One']);
    // A catalog row whose Durable Object was never initialised: `projectSummary` throws on it.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json)
         VALUES ('brd_ghost', 'tnt_r', 'ghost', '[]')`,
    ).run();

    const r = await computeRollup(env.DB, env, 'tnt_r', p.id);
    // It must NOT throw, and must NOT report a confident total.
    expect(r.partial).toBe(true);
    expect(r.boardsUnanswered).toBe(1);
    expect(r.cardsTotal).toBe(1);
  });
});

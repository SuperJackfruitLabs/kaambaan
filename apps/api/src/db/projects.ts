/**
 * Projects and milestones (migration 0013).
 *
 * A project groups cards ACROSS boards; a milestone is an ordered checkpoint inside one project.
 * Both live in D1, not in a board's Durable Object, because that is the whole point — the spec's
 * spine is that anything that may refuse a claim or an advance lives in the board DO and is
 * strongly consistent, and anything merely informational lives in D1 and may span boards. A
 * project cannot be consulted on the claim path (it would mean a cross-DO read) and it never
 * refuses anything; it is purely descriptive, the same way `labels` (migration 0010) is.
 *
 * Follows `db/labels.ts`'s shape: hand-written SQL, `tenant_id = ?` first in every WHERE clause.
 */
import { newId } from '../ids';
import type { Env } from '../env';
import { boardStub } from '../board/stub';
import { listAllBoards } from './catalog';

export type ProjectState = 'planned' | 'active' | 'paused' | 'completed' | 'canceled';
export type ProjectHealth = 'on-track' | 'at-risk' | 'off-track';

/** Exported so the route can validate a request body against the same list this module enforces,
 *  rather than a second hand-copied one drifting from it over time. */
export const PROJECT_STATES: readonly ProjectState[] = ['planned', 'active', 'paused', 'completed', 'canceled'];
export const PROJECT_HEALTHS: readonly ProjectHealth[] = ['on-track', 'at-risk', 'off-track'];

export interface ProjectRecord {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  state: ProjectState;
  health: ProjectHealth | null;
  leadUserId: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface MilestoneRecord {
  id: string;
  projectId: string;
  tenantId: string;
  name: string;
  targetDate: string | null;
  sortOrder: number;
  createdAt: string;
}

const PROJECT_COLUMNS = `id, tenant_id AS tenantId, name, description, target_date AS targetDate,
                          state, health, lead_user_id AS leadUserId,
                          created_at AS createdAt, updated_at AS updatedAt`;

const MILESTONE_COLUMNS = `id, project_id AS projectId, tenant_id AS tenantId, name,
                            target_date AS targetDate, sort_order AS sortOrder, created_at AS createdAt`;

/**
 * Is this D1's own report of a `projects` name collision — `0013`'s `UNIQUE (tenant_id, name)`?
 * Narrow on purpose, the same reasoning as `isLabelNameCollision`: the route's catch must convert
 * this one failure into a clean sentence and let everything else fall through unaltered.
 */
export function isProjectNameCollision(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? '';
  return message.includes('UNIQUE constraint failed: projects.tenant_id, projects.name');
}

export async function listProjects(db: D1Database, tenantId: string): Promise<ProjectRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE tenant_id = ? ORDER BY name ASC`)
    .bind(tenantId)
    .all<ProjectRecord>();
  return results ?? [];
}

export async function projectById(db: D1Database, tenantId: string, id: string): Promise<ProjectRecord | null> {
  return (
    (await db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE tenant_id = ? AND id = ?`)
      .bind(tenantId, id)
      .first<ProjectRecord>()) ?? null
  );
}

export async function createProject(
  db: D1Database,
  tenantId: string,
  input: {
    name: string;
    description?: string | null;
    targetDate?: string | null;
    state?: ProjectState;
    leadUserId?: string | null;
  },
): Promise<ProjectRecord> {
  const name = input.name.trim();
  if (name === '') throw new Error('a project needs a name');
  const state = input.state ?? 'active';
  if (!PROJECT_STATES.includes(state)) throw new Error(`unknown project state: "${state}"`);
  const id = newId('prj');
  await db
    .prepare(
      `INSERT INTO projects (id, tenant_id, name, description, target_date, state, lead_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, tenantId, name, input.description ?? null, input.targetDate ?? null, state, input.leadUserId ?? null)
    .run();
  const row = await projectById(db, tenantId, id);
  if (!row) throw new Error('project vanished immediately after insert');
  return row;
}

export async function updateProject(
  db: D1Database,
  tenantId: string,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    targetDate?: string | null;
    state?: ProjectState;
    health?: ProjectHealth | null;
    leadUserId?: string | null;
  },
): Promise<ProjectRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === '') throw new Error('a project needs a name');
    sets.push('name = ?');
    params.push(name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description);
  }
  if (patch.targetDate !== undefined) {
    sets.push('target_date = ?');
    params.push(patch.targetDate);
  }
  if (patch.state !== undefined) {
    if (!PROJECT_STATES.includes(patch.state)) throw new Error(`unknown project state: "${patch.state}"`);
    sets.push('state = ?');
    params.push(patch.state);
  }
  if (patch.health !== undefined) {
    if (patch.health !== null && !PROJECT_HEALTHS.includes(patch.health)) {
      throw new Error(`unknown project health: "${patch.health}"`);
    }
    sets.push('health = ?');
    params.push(patch.health);
  }
  if (patch.leadUserId !== undefined) {
    sets.push('lead_user_id = ?');
    params.push(patch.leadUserId);
  }
  if (sets.length === 0) return projectById(db, tenantId, id);
  sets.push(`updated_at = datetime('now')`);
  await db
    .prepare(`UPDATE projects SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`)
    .bind(...params, tenantId, id)
    .run();
  return projectById(db, tenantId, id);
}

/**
 * Delete a project. Milestones cascade (`ON DELETE CASCADE`, migration 0013), the same way
 * `project_rollups` does.
 *
 * Unconditional about cards that may still reference it — and the rule this follows is not
 * "deletes here are permissive", it is: refuse when the references are visible to you, accept
 * dangling ones only when the architecture puts them out of reach.
 *
 * `DELETE /v1/labels/:id` (`deleteLabel`) and this are the "out of reach" case: a label is
 * referenced only by a card id stored on the card itself, which lives in a board Durable Object
 * neither route can see, so there is nothing local left to check.
 *
 * `DELETE /v1/capabilities/:id` is the OTHER case, and it is not a weaker version of this rule —
 * it is the counter-example that proves it. A capability's references (agents, boards,
 * implications) are entirely in D1, so `capabilityUsage` is one cheap local query, and that
 * route genuinely refuses with 409 when any exist (`index.ts`, `DELETE /v1/capabilities/:id`).
 * It can check, so it does.
 *
 * A project is the label's case, not the capability's: cards carrying this project's (or one of
 * its milestones') id live in board Durable Objects this module cannot and must not reach —
 * checking would mean exactly the cross-DO read the spec forbids on a write path, and a stale
 * answer to "is this project referenced anywhere?" is either a delete that is wrongly blocked or
 * wrongly allowed. Readers (Task 19's rollup, the card view) are expected to treat a
 * `project_id`/`milestone_id` that no longer resolves the same way a dead label id is already
 * treated: ignored, not fatal.
 */
export async function deleteProject(db: D1Database, tenantId: string, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM projects WHERE tenant_id = ? AND id = ?`).bind(tenantId, id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listMilestones(db: D1Database, tenantId: string, projectId: string): Promise<MilestoneRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${MILESTONE_COLUMNS} FROM milestones WHERE tenant_id = ? AND project_id = ?
       ORDER BY sort_order ASC, name ASC`,
    )
    .bind(tenantId, projectId)
    .all<MilestoneRecord>();
  return results ?? [];
}

export async function milestoneById(db: D1Database, tenantId: string, id: string): Promise<MilestoneRecord | null> {
  return (
    (await db
      .prepare(`SELECT ${MILESTONE_COLUMNS} FROM milestones WHERE tenant_id = ? AND id = ?`)
      .bind(tenantId, id)
      .first<MilestoneRecord>()) ?? null
  );
}

/**
 * Creating a milestone against a project id that is not actually this tenant's is refused —
 * checked here rather than left to the `project_id` foreign key, because a cross-tenant project
 * id DOES satisfy that FK (the row exists, just under a different tenant) and would otherwise
 * attach a milestone a second tenant could then read via `listMilestones(db, theirTenant, ...)`.
 */
export async function createMilestone(
  db: D1Database,
  tenantId: string,
  projectId: string,
  input: { name: string; targetDate?: string | null; sortOrder?: number },
): Promise<MilestoneRecord> {
  const name = input.name.trim();
  if (name === '') throw new Error('a milestone needs a name');
  const owned = await projectById(db, tenantId, projectId);
  if (!owned) throw new Error('no such project in this workspace');
  const id = newId('mls');
  await db
    .prepare(
      `INSERT INTO milestones (id, project_id, tenant_id, name, target_date, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, projectId, tenantId, name, input.targetDate ?? null, input.sortOrder ?? 0)
    .run();
  const row = await milestoneById(db, tenantId, id);
  if (!row) throw new Error('milestone vanished immediately after insert');
  return row;
}

export async function updateMilestone(
  db: D1Database,
  tenantId: string,
  id: string,
  patch: { name?: string; targetDate?: string | null; sortOrder?: number },
): Promise<MilestoneRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === '') throw new Error('a milestone needs a name');
    sets.push('name = ?');
    params.push(name);
  }
  if (patch.targetDate !== undefined) {
    sets.push('target_date = ?');
    params.push(patch.targetDate);
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?');
    params.push(patch.sortOrder);
  }
  if (sets.length === 0) return milestoneById(db, tenantId, id);
  await db
    .prepare(`UPDATE milestones SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`)
    .bind(...params, tenantId, id)
    .run();
  return milestoneById(db, tenantId, id);
}

export async function deleteMilestone(db: D1Database, tenantId: string, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM milestones WHERE tenant_id = ? AND id = ?`).bind(tenantId, id).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Every project in the deployment, tenant and all — `listAllBoards`'s own shape (`db/catalog.ts`)
 * and the same reason: the scheduled refresh has no caller and therefore no tenant to scope to.
 * Not exported through any route; the only caller is `scheduled()`.
 */
export async function listAllProjects(db: D1Database): Promise<Array<{ id: string; tenantId: string }>> {
  const { results } = await db
    .prepare(`SELECT id, tenant_id AS tenantId FROM projects ORDER BY created_at ASC`)
    .all<{ id: string; tenantId: string }>();
  return results ?? [];
}

export interface ProjectRollup {
  projectId: string;
  cardsTotal: number;
  cardsDone: number;
  cardsOverdue: number;
  costUsd: number;
  computedAt: string;
  /** True when one or more boards failed to answer — see `computeRollup`. */
  partial: boolean;
  /** How many boards failed to answer. 0 whenever `partial` is false. */
  boardsUnanswered: number;
}

interface ProjectRollupRow {
  project_id: string;
  cards_total: number;
  cards_done: number;
  cards_overdue: number;
  cost_usd: number;
  computed_at: string;
  partial: number;
  boards_unanswered: number;
}

function rollupFromRow(row: ProjectRollupRow): ProjectRollup {
  return {
    projectId: row.project_id,
    cardsTotal: Number(row.cards_total),
    cardsDone: Number(row.cards_done),
    cardsOverdue: Number(row.cards_overdue),
    costUsd: Number(row.cost_usd),
    computedAt: row.computed_at,
    partial: Number(row.partial) === 1,
    boardsUnanswered: Number(row.boards_unanswered),
  };
}

/** The cached row `computeRollup` last wrote, or null if this project has never been computed. */
export async function cachedRollup(db: D1Database, tenantId: string, projectId: string): Promise<ProjectRollup | null> {
  const row = await db
    .prepare(`SELECT * FROM project_rollups WHERE tenant_id = ? AND project_id = ?`)
    .bind(tenantId, projectId)
    .first<ProjectRollupRow>();
  return row ? rollupFromRow(row) : null;
}

/**
 * The one fan-out in this design.
 *
 * Everything else in superpipeline keeps the spine the rest of this module's comments describe:
 * anything that may REFUSE a claim or an advance lives in one board's Durable Object and is
 * strongly consistent; anything merely informational lives here in D1 and may span boards. This
 * is that second kind, taken to its fan-out conclusion — it reads every board belonging to this
 * tenant and is stale the instant it returns. That is acceptable only because nothing may ever
 * decide anything on it: this function (and the cached row it writes) must never be read by the
 * claim path, the advance path, or any refusal.
 *
 * **Tenant-scoped on purpose, even though `listAllBoards` is not.** `listAllBoards` is the cron's
 * global walk across every tenant in the deployment (see its own comment in `db/catalog.ts`) — a
 * fan-out that used its result unfiltered would read, and sum into one tenant's total, cards that
 * belong to a completely different workspace. Filtering here, before a single board stub is
 * touched, is what keeps a project's rollup inside its own tenant.
 *
 * **Partial, and says so.** A board's Durable Object may throw — never initialized, a transient
 * error, anything — and one board's failure must not make the whole rollup throw, nor silently
 * under-count. Each board is called in its own try/catch; a throw is counted in
 * `boardsUnanswered` and skipped, never allowed to turn into a confidently wrong total. The
 * caller (the route, and Task 20's UI) is expected to say so whenever `partial` is true, the same
 * way `overBudget` exists to be surfaced rather than silently absorbed.
 */
export async function computeRollup(
  db: D1Database,
  env: Env,
  tenantId: string,
  projectId: string,
): Promise<ProjectRollup> {
  const boards = (await listAllBoards(db)).filter((b) => b.tenantId === tenantId);

  let cardsTotal = 0;
  let cardsDone = 0;
  let cardsOverdue = 0;
  let costUsd = 0;
  let boardsUnanswered = 0;

  for (const board of boards) {
    try {
      const result = await boardStub(env, tenantId, board.id).projectSummary(projectId);
      // `{ ok: false }` (a board whose DO was never initialized) and a genuinely thrown error
      // (anything else — a transient failure, a bug) are the same fact from this fan-out's point
      // of view: one board did not answer. Both land here as "unanswered", never as a thrown
      // exception that would abort the whole rollup.
      if (!result.ok) {
        boardsUnanswered += 1;
        continue;
      }
      cardsTotal += result.value.total;
      cardsDone += result.value.done;
      cardsOverdue += result.value.overdue;
      costUsd += result.value.costUsd;
    } catch {
      boardsUnanswered += 1;
    }
  }

  const partial = boardsUnanswered > 0;
  const computedAt = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO project_rollups
         (project_id, tenant_id, cards_total, cards_done, cards_overdue, cost_usd, computed_at, partial, boards_unanswered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         cards_total = excluded.cards_total,
         cards_done = excluded.cards_done,
         cards_overdue = excluded.cards_overdue,
         cost_usd = excluded.cost_usd,
         computed_at = excluded.computed_at,
         partial = excluded.partial,
         boards_unanswered = excluded.boards_unanswered`,
    )
    .bind(projectId, tenantId, cardsTotal, cardsDone, cardsOverdue, costUsd, computedAt, partial ? 1 : 0, boardsUnanswered)
    .run();

  return { projectId, cardsTotal, cardsDone, cardsOverdue, costUsd, computedAt, partial, boardsUnanswered };
}

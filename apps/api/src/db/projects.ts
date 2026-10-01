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
 * Permissive about cards, the same way `deleteLabel` and `deleteCapability` are about cards and
 * agents that still reference them: cards carrying this project's (or one of its milestones')
 * id live in board Durable Objects this module cannot and must not reach — refusing the delete
 * while any exist would require exactly the cross-DO read the spec forbids on a write path, and
 * a stale answer to "is this project referenced anywhere?" is either a delete that is wrongly
 * blocked or wrongly allowed. Readers (Task 19's rollup, the card view) are expected to treat a
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

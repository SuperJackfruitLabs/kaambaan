/**
 * What one capability implies about another (migration 0007).
 *
 * Routing is exact string equality, deliberately — when a card does not move, the diagnosis must
 * stay a comparison anyone can run by hand, and a similarity score would make that same failure
 * unfalsifiable. But equality alone cannot say that `code-review` is a kind of `code`, so renaming
 * a lane strands every agent staffed for the old tag, and an agent that can plainly do the work is
 * refused for having spelled its competence one level down.
 *
 * These are edges, not a hierarchy: no root, no depth limit, no single tree. A capability may
 * imply several and be implied by several.
 *
 * **Declared vs effective.** An agent's DECLARED set is what an operator typed. Its EFFECTIVE set
 * is the transitive closure over these edges, and that is what routing matches on. The two must
 * both be visible wherever an operator reasons about staffing — a diagnostic counting effective
 * holders while showing declared ones is a diagnostic that lies.
 */
import { capabilityTag, capabilityTags } from '@kaambaan/contract';

export interface Implication {
  from: string;
  to: string;
}

/** Every edge in a workspace. Small by nature — one row per relationship an operator declared. */
export async function listImplications(db: D1Database, tenantId: string): Promise<Implication[]> {
  const { results } = await db
    .prepare(
      `SELECT implies_from AS "from", implies_to AS "to" FROM capability_implications
       WHERE tenant_id = ? ORDER BY implies_from, implies_to`,
    )
    .bind(tenantId)
    .all<Implication>();
  return results;
}

export type ImplicationError = 'SELF_IMPLICATION' | 'EMPTY_KEY';

/**
 * Declare that holding `from` also means holding `to`.
 *
 * A self-edge is refused here rather than by a constraint, so an operator reads a sentence instead
 * of a database error. Idempotent: re-declaring an existing edge is a no-op, because the operator
 * asked for a state and that state already holds.
 */
export async function addImplication(
  db: D1Database,
  tenantId: string,
  from: string,
  to: string,
  createdBy: string | null,
): Promise<{ ok: true } | { ok: false; code: ImplicationError }> {
  const f = capabilityTag(from);
  const t = capabilityTag(to);
  if (f === '' || t === '') return { ok: false, code: 'EMPTY_KEY' };
  if (f === t) return { ok: false, code: 'SELF_IMPLICATION' };
  await db
    .prepare(
      `INSERT INTO capability_implications (tenant_id, implies_from, implies_to, created_by)
       VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, implies_from, implies_to) DO NOTHING`,
    )
    .bind(tenantId, f, t, createdBy)
    .run();
  return { ok: true };
}

export async function removeImplication(
  db: D1Database,
  tenantId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `DELETE FROM capability_implications WHERE tenant_id = ? AND implies_from = ? AND implies_to = ?`,
    )
    .bind(tenantId, capabilityTag(from), capabilityTag(to))
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Expand a declared set into the effective set routing matches on.
 *
 * A breadth-first walk with a seen-set, so a cycle terminates rather than being refused at write
 * time: `a implies b implies a` has said something odd but nothing dangerous — the closure is
 * `{a, b}` from either end — and refusing it would mean a graph traversal on every write to
 * prevent a case that is harmless to survive.
 *
 * The declared members are always present in the result, whether or not any edge mentions them.
 */
export function expand(declared: string[], edges: Implication[]): string[] {
  const out = capabilityTags(declared);
  if (edges.length === 0) return out;

  const byFrom = new Map<string, string[]>();
  for (const e of edges) {
    const list = byFrom.get(e.from);
    if (list) list.push(e.to);
    else byFrom.set(e.from, [e.to]);
  }

  const seen = new Set(out);
  const queue = [...out];
  while (queue.length > 0) {
    const next = byFrom.get(queue.shift()!);
    if (!next) continue;
    for (const to of next) {
      if (seen.has(to)) continue; // terminates cycles, and stops re-walking a shared ancestor
      seen.add(to);
      out.push(to);
      queue.push(to);
    }
  }
  return out;
}

/**
 * The effective set for an agent, read from the workspace's edges.
 *
 * Returns the declared set unchanged when a workspace has declared no relationships, which is the
 * normal case and costs one indexed read.
 */
export async function effectiveCapabilities(
  db: D1Database,
  tenantId: string,
  declared: string[],
): Promise<string[]> {
  if (declared.length === 0) return [];
  return expand(declared, await listImplications(db, tenantId));
}

/**
 * The capability registry (migration 0006).
 *
 * A capability was a free string on both sides of an equality test —
 * `agent.capabilities.includes(stage.owner)` — with nothing defining the set, so every producer
 * invented its own vocabulary and almost nothing matched. This is where a capability gets an
 * identity, a definition and a provenance.
 *
 * **It does not enumerate what may exist.** Four of the five reference agent registries — MCP,
 * A2A, Entra, NANDA — deliberately decline to define a vocabulary and standardise the record
 * instead; only AGNTCY/OASF ships a taxonomy, and even that is extensible. A closed list would be
 * a migration every time somebody adds a stage.
 *
 * The shape is A2A's `AgentSkill` (`id, name, description, tags, examples`), so a future
 * AgentCard is a projection of these rows rather than a translation of them, and the optional
 * `externalId`/`externalSource` pair is how one is ALSO known in OASF — the same borrowing
 * pattern `tenants` and `agents` already use, with the same all-or-nothing rule.
 */
import { capabilityTag } from '@kaambaan/contract';
import { newId } from '../ids';
import { ExternalMappingError } from './catalog';

/**
 * How a capability came to exist, which is the fact the mismatch hid.
 *
 * `declared` — someone defined it deliberately, and meant it.
 * `inferred` — it turned up as a stage owner and was registered on first use.
 *
 * Recorded rather than hidden because "which of these did nobody ever mean to create?" is exactly
 * the question that could not be asked before, and it is how a typo is found after the fact.
 */
export type CapabilityOrigin = 'declared' | 'inferred';

export interface CapabilityRecord {
  id: string;
  tenantId: string;
  /** The routing tag — the value stages and agents actually carry. One spelling per workspace. */
  key: string;
  name: string;
  description: string | null;
  tags: string[];
  examples: string[];
  origin: CapabilityOrigin;
  createdBy: string | null;
  /** Where this capability is also known — an OASF dotted id, say. Null is the normal state. */
  externalId: string | null;
  externalSource: string | null;
  /**
   * How many agents hold this, and how many boards name it on a stage.
   *
   * Present only on the list read, which is where they are asked for. Zero agents means a lane
   * nobody can work; zero boards means a capability that matches nothing — the shape of the bug
   * that shipped.
   */
  agentCount?: number;
  boardCount?: number;
}

interface Row {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  description: string | null;
  tagsJson: string;
  examplesJson: string;
  origin: string;
  createdBy: string | null;
  externalId: string | null;
  externalSource: string | null;
}

const COLUMNS = `id, tenant_id AS tenantId, key, name, description, tags_json AS tagsJson,
                 examples_json AS examplesJson, origin, created_by AS createdBy,
                 external_id AS externalId, external_source AS externalSource`;

function toRecord(r: Row): CapabilityRecord {
  return {
    id: r.id,
    tenantId: r.tenantId,
    key: r.key,
    name: r.name,
    description: r.description,
    tags: JSON.parse(r.tagsJson) as string[],
    examples: JSON.parse(r.examplesJson) as string[],
    origin: (r.origin === 'inferred' ? 'inferred' : 'declared') as CapabilityOrigin,
    createdBy: r.createdBy,
    externalId: r.externalId,
    externalSource: r.externalSource,
  };
}

/**
 * Every capability this workspace knows, alphabetically, each with who refers to it.
 *
 * The counts are the point, not decoration. A capability held by agents and named by no stage is
 * an agent that can claim nothing — the exact bug that shipped, where thirteen agents carried
 * `claim` (a token scope) and matched no lane in any board. A capability named by a stage and
 * held by no agent is a lane no one can work. Both are invisible until something counts them.
 *
 * Correlated subqueries rather than joins: an agent holding three capabilities must not multiply
 * this list into three rows.
 */
export async function listCapabilities(db: D1Database, tenantId: string): Promise<CapabilityRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS},
              (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = c.tenant_id
                 AND EXISTS (SELECT 1 FROM json_each(a.capabilities_json) WHERE value = c.key)) AS agentCount,
              (SELECT COUNT(*) FROM boards b WHERE b.tenant_id = c.tenant_id
                 AND EXISTS (SELECT 1 FROM json_each(b.stages_json)
                             WHERE json_extract(value, '$.ownerKind') = 'capability'
                               AND json_extract(value, '$.owner') = c.key)) AS boardCount
       FROM capabilities c WHERE c.tenant_id = ? ORDER BY c.key ASC`,
    )
    .bind(tenantId)
    .all<Row & { agentCount: number; boardCount: number }>();
  return results.map((r) => ({ ...toRecord(r), agentCount: Number(r.agentCount), boardCount: Number(r.boardCount) }));
}

/** Which of these keys this workspace has never heard of. Empty means every one is known. */
export async function unknownCapabilities(db: D1Database, tenantId: string, keys: string[]): Promise<string[]> {
  const wanted = [...new Set(keys.map(capabilityTag).filter((k) => k !== ''))];
  if (wanted.length === 0) return [];
  const placeholders = wanted.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT key FROM capabilities WHERE tenant_id = ? AND key IN (${placeholders})`)
    .bind(tenantId, ...wanted)
    .all<{ key: string }>();
  const known = new Set(results.map((r) => r.key));
  return wanted.filter((k) => !known.has(k));
}

/**
 * Register any of these keys the workspace does not already know, as `inferred`.
 *
 * **Every write path registers — deliberately, after trying the stricter rule and rejecting it.**
 *
 * The first design made stages declaring and agents referencing: an agent claiming a capability
 * no stage had named would be refused. It is a tidy rule and it is the wrong one, for two
 * reasons. It dead-ends the obvious first move — a workspace with no boards has no capabilities,
 * so you could not staff your first agent until you had made a board. And it only ever prevents
 * the NEXT typo: the thirteen agents in production already holding `claim` would sail through
 * untouched, because they were written before any rule existed.
 *
 * Registering everything and recording where it came from catches both. `capabilityUsage` can
 * then say "`claim` — held by 13 agents, named by no stage", which is the diagnostic that
 * actually finds the bug we shipped, and finds it retroactively.
 *
 * Idempotent, and it never overwrites a `declared` row: `ON CONFLICT DO NOTHING`, so a capability
 * somebody wrote a real description for keeps it.
 */
export async function ensureCapabilities(
  db: D1Database,
  tenantId: string,
  keys: string[],
  createdBy: string | null,
): Promise<string[]> {
  const missing = await unknownCapabilities(db, tenantId, keys);
  if (missing.length === 0) return [];
  await db.batch(
    missing.map((key) =>
      db
        .prepare(
          `INSERT INTO capabilities (id, tenant_id, key, name, origin, created_by)
           VALUES (?, ?, ?, ?, 'inferred', ?)
           ON CONFLICT(tenant_id, key) DO NOTHING`,
        )
        // The key doubles as the name until a person gives it a better one. A capability with no
        // label is worse than one labelled with its own tag: the picker has something to show.
        .bind(newId('cap'), tenantId, key, key, createdBy),
    ),
  );
  return missing;
}

/** Guard for the external pair, matching `setAgentExternalMapping`'s rule exactly. */
function assertPair(externalId: string | null | undefined, externalSource: string | null | undefined): void {
  const hasId = typeof externalId === 'string' && externalId.trim() !== '';
  const hasSource = typeof externalSource === 'string' && externalSource.trim() !== '';
  if (hasId !== hasSource) {
    throw new ExternalMappingError('externalId and externalSource must be set together, or not at all');
  }
}

/**
 * Define a capability deliberately.
 *
 * Returns null when the key already exists — a collision is the caller's to report as a sentence,
 * not a raw UNIQUE failure, and re-declaring an existing capability is a rename, not a create.
 */
export async function createCapability(
  db: D1Database,
  tenantId: string,
  input: {
    key: string;
    name?: string;
    description?: string | null;
    tags?: string[];
    examples?: string[];
    externalId?: string | null;
    externalSource?: string | null;
    createdBy?: string | null;
  },
): Promise<CapabilityRecord | null> {
  const key = capabilityTag(input.key);
  if (key === '') return null;
  assertPair(input.externalId, input.externalSource);

  const existing = await db
    .prepare(`SELECT ${COLUMNS} FROM capabilities WHERE tenant_id = ? AND key = ?`)
    .bind(tenantId, key)
    .first<Row>();
  if (existing) return null;

  const id = newId('cap');
  await db
    .prepare(
      `INSERT INTO capabilities (id, tenant_id, key, name, description, tags_json, examples_json,
                                 origin, created_by, external_id, external_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'declared', ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      key,
      input.name?.trim() || key,
      input.description ?? null,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.examples ?? []),
      input.createdBy ?? null,
      input.externalId ?? null,
      input.externalSource ?? null,
    )
    .run();

  return {
    id,
    tenantId,
    key,
    name: input.name?.trim() || key,
    description: input.description ?? null,
    tags: input.tags ?? [],
    examples: input.examples ?? [],
    origin: 'declared',
    createdBy: input.createdBy ?? null,
    externalId: input.externalId ?? null,
    externalSource: input.externalSource ?? null,
  };
}

/**
 * Edit a capability's description, without changing what it routes.
 *
 * `key` is deliberately absent: it is what stages and agents already carry, so renaming it in
 * place would orphan every one of them silently — the identical reason a board's stage key cannot
 * be renamed. Give a capability a better `name` instead, or make a new one and restaff.
 *
 * Filling in a description promotes an `inferred` capability to `declared`: somebody has now
 * looked at it and meant it, which is exactly what that column records.
 */
export async function updateCapability(
  db: D1Database,
  tenantId: string,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    tags?: string[];
    examples?: string[];
    externalId?: string | null;
    externalSource?: string | null;
  },
): Promise<boolean> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    vals.push(patch.description);
  }
  if (patch.tags !== undefined) {
    sets.push('tags_json = ?');
    vals.push(JSON.stringify(patch.tags));
  }
  if (patch.examples !== undefined) {
    sets.push('examples_json = ?');
    vals.push(JSON.stringify(patch.examples));
  }
  if (patch.externalId !== undefined || patch.externalSource !== undefined) {
    assertPair(patch.externalId, patch.externalSource);
    sets.push('external_id = ?', 'external_source = ?');
    vals.push(patch.externalId ?? null, patch.externalSource ?? null);
  }
  if (sets.length === 0) return false;
  sets.push(`origin = 'declared'`, `updated_at = datetime('now')`);
  const res = await db
    .prepare(`UPDATE capabilities SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`)
    .bind(...vals, tenantId, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** One capability by id, tenant-scoped. */
export async function capabilityById(db: D1Database, tenantId: string, id: string): Promise<CapabilityRecord | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM capabilities WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, id)
    .first<Row>();
  return row ? toRecord(row) : null;
}

/**
 * Who still refers to this capability.
 *
 * Deleting one that a stage or an agent still names would silently un-route work: the string stays
 * on both, matching continues to work, and the registry quietly stops describing the product. So
 * the delete route asks this first and refuses with the answer.
 */
export async function capabilityUsage(
  db: D1Database,
  tenantId: string,
  key: string,
): Promise<{ agents: string[]; boards: string[] }> {
  const { results: agents } = await db
    .prepare(
      `SELECT name FROM agents
       WHERE tenant_id = ? AND EXISTS (SELECT 1 FROM json_each(capabilities_json) WHERE value = ?)`,
    )
    .bind(tenantId, key)
    .all<{ name: string }>();
  const { results: boards } = await db
    .prepare(
      `SELECT name FROM boards
       WHERE tenant_id = ? AND EXISTS (
         SELECT 1 FROM json_each(stages_json)
         WHERE json_extract(value, '$.ownerKind') = 'capability' AND json_extract(value, '$.owner') = ?
       )`,
    )
    .bind(tenantId, key)
    .all<{ name: string }>();
  return { agents: agents.map((a) => a.name), boards: boards.map((b) => b.name) };
}

/** Remove a capability. The caller checks `capabilityUsage` first. */
export async function deleteCapability(db: D1Database, tenantId: string, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM capabilities WHERE tenant_id = ? AND id = ?`).bind(tenantId, id).run();
  return (res.meta?.changes ?? 0) > 0;
}

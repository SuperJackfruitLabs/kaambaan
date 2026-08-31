import { tenantScopedSelect, type ScopedQuery } from './tenant-scope';
import { newId } from '../ids';
import { generateAgentToken, hashToken } from '../auth/agent-token';

/** The catalog is the cross-board system of record (docs/02): users, workspaces, agents, tokens. */
export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
}
/**
 * A tenant is kaambaan's LOCAL isolation boundary, not an authority on who anyone is. The
 * external pair optionally records that the same real organisation is also known elsewhere:
 * `externalSource` names the system, `externalId` is its (opaque) id. Both or neither — see
 * `setTenantExternalMapping` and migrations/0002_tenant_external_mapping.sql.
 */
export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  externalId: string | null;
  externalSource: string | null;
}

/** Where a tenant is also known, outside kaambaan. */
export interface TenantExternalMapping {
  externalId: string;
  externalSource: string;
}

/** A half-recorded external mapping — an id whose id space nobody can name, or the reverse. */
export class ExternalMappingError extends Error {
  constructor(message = 'externalId and externalSource must be set together, or not at all') {
    super(message);
    this.name = 'ExternalMappingError';
  }
}

/**
 * A registered kaambaan agent — always addressable by its native `agt_…` id and `kbn_` bearer
 * token, which are permanent regardless of the external pair below.
 *
 * The external pair optionally records that this same agent is also known as a suite principal
 * elsewhere: `externalSource` names the system (`'org-plane'`, once one exists), `externalId` is
 * that system's id for it (a `prn_…`, opaque here — see `setAgentExternalMapping` and
 * migrations/0003_agent_external_mapping.sql). Exactly the pair `tenants` already carries.
 */
export interface AgentRecord {
  id: string;
  tenantId: string;
  name: string;
  capabilities: string[];
  externalId: string | null;
  externalSource: string | null;
  /**
   * Ids of this agent's active (non-revoked) `kbn_` tokens — what the console needs to offer a
   * "revoke" action without holding onto the one-time plaintext-mint response. Empty is a real,
   * complete state (an agent with nothing active cannot authenticate until reconnected), not an
   * omission.
   */
  tokenIds: string[];
}

/** Where an agent is also known, as a suite principal outside kaambaan. */
export interface AgentExternalMapping {
  externalId: string;
  externalSource: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
}

/** Create or update a user by email (the GitHub-login upsert). */
export async function upsertUserByEmail(db: D1Database, input: { email: string; name?: string | null }): Promise<UserRecord> {
  const existing = await db.prepare(`SELECT id, email, name FROM users WHERE email = ?`).bind(input.email).first<UserRecord>();
  if (existing) {
    if (input.name && input.name !== existing.name) {
      await db.prepare(`UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?`).bind(input.name, existing.id).run();
    }
    return { ...existing, name: input.name ?? existing.name };
  }
  const id = newId('usr');
  await db.prepare(`INSERT INTO users (id, email, name) VALUES (?, ?, ?)`).bind(id, input.email, input.name ?? null).run();
  return { id, email: input.email, name: input.name ?? null };
}

/** The user's primary workspace, creating a personal one (owner) on first sign-in (docs/05 §7). */
export async function ensurePersonalWorkspace(db: D1Database, userId: string, displayName: string): Promise<TenantRecord> {
  const existing = await primaryTenant(db, userId);
  if (existing) return existing;
  const id = newId('tnt');
  // No external mapping: a personal workspace answers to nothing outside kaambaan, and that is a
  // complete tenant. A mapping is recorded later, by whoever links this boundary to an org.
  const tenant: TenantRecord = {
    id,
    slug: `${slugify(displayName)}-${id.slice(-6)}`,
    name: `${displayName}'s workspace`,
    externalId: null,
    externalSource: null,
  };
  await db.prepare(`INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)`).bind(tenant.id, tenant.slug, tenant.name).run();
  await db.prepare(`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, 'owner')`).bind(newId('mbr'), id, userId).run();
  return tenant;
}

export async function primaryTenant(db: D1Database, userId: string): Promise<TenantRecord | null> {
  return db
    .prepare(
      `SELECT t.id, t.slug, t.name, t.external_id AS externalId, t.external_source AS externalSource
       FROM tenants t JOIN memberships m ON m.tenant_id = t.id WHERE m.user_id = ? ORDER BY m.created_at ASC LIMIT 1`,
    )
    .bind(userId)
    .first<TenantRecord>();
}

/**
 * Record (or clear, with `null`) where this tenant is also known outside kaambaan.
 *
 * The pair is all-or-nothing and the database enforces it (`tenants_external_pair`); this guard
 * exists so the failure names the mistake instead of surfacing as a SQLITE_CONSTRAINT. Recording
 * an id without the system it came from is worse than recording nothing: an unattributed id
 * cannot be joined against anything, and a wrong join is harder to notice than a missing one.
 *
 * Nothing calls this yet — the shape is reserved ahead of its first writer, which is the only
 * moment it is free to get right. It changes no existing behaviour: a tenant with no mapping is
 * exactly the tenant kaambaan has today.
 */
export async function setTenantExternalMapping(
  db: D1Database,
  tenantId: string,
  mapping: TenantExternalMapping | null,
): Promise<void> {
  if (mapping !== null) {
    const { externalId, externalSource } = mapping;
    if (typeof externalId !== 'string' || externalId.trim() === '') {
      throw new ExternalMappingError('an external mapping needs an externalId');
    }
    if (typeof externalSource !== 'string' || externalSource.trim() === '') {
      throw new ExternalMappingError('an external mapping needs an externalSource naming whose id it is');
    }
  }
  await db
    .prepare(`UPDATE tenants SET external_id = ?, external_source = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(mapping?.externalId ?? null, mapping?.externalSource ?? null, tenantId)
    .run();
}

export async function createAgent(db: D1Database, tenantId: string, input: { name: string; capabilities?: string[] }): Promise<AgentRecord> {
  const id = newId('agt');
  const capabilities = input.capabilities ?? [];
  await db.prepare(`INSERT INTO agents (id, tenant_id, name, capabilities_json) VALUES (?, ?, ?, ?)`).bind(id, tenantId, input.name, JSON.stringify(capabilities)).run();
  // No external mapping: a freshly registered agent answers to nothing outside kaambaan, and
  // that is a complete agent. A mapping is recorded later, by whoever links it to a principal.
  // No tokens either — this function mints none; the REST route mints one right after.
  return { id, tenantId, name: input.name, capabilities, externalId: null, externalSource: null, tokenIds: [] };
}

/**
 * Record (or clear, with `null`) where this agent is also known, as a suite principal, outside
 * kaambaan. Mirrors `setTenantExternalMapping` exactly — same all-or-nothing guard, same
 * database-enforced CHECK (`agents_external_pair`, migration 0003) backing it up.
 *
 * **Corrected 2026-08-31.** This used to say "nothing calls this yet". The one caller is
 * `PATCH /v1/agents/:id` (index.ts): a human validates the `prn_[0-9a-f]{20}` shape and calls
 * this. It is what lets `resolveHubAgent` turn an agent-kind hub token into a local agent — until
 * a mapping is recorded, there is nothing for that resolver to find. It changes no existing
 * behaviour on its own: an agent nobody has linked is exactly the agent kaambaan has today.
 *
 * **Tenant-scoped, like `revokeAgentToken`.** `agents.id` is a bare primary key with no
 * per-tenant uniqueness (a previous review found that load-bearing for `revokeAgentToken`'s own
 * `WHERE`); the same is true here. The route caller already runs `agentBelongsToTenant` first —
 * that check is real and this is not, today, a reachable bug through it — but a guard that lives
 * only in one caller protects that caller and nobody else. The `WHERE` clause below is that
 * defence in depth, not a replacement for the route's 404.
 */
export async function setAgentExternalMapping(
  db: D1Database,
  tenantId: string,
  agentId: string,
  mapping: AgentExternalMapping | null,
): Promise<void> {
  if (mapping !== null) {
    const { externalId, externalSource } = mapping;
    if (typeof externalId !== 'string' || externalId.trim() === '') {
      throw new ExternalMappingError('an external mapping needs an externalId');
    }
    if (typeof externalSource !== 'string' || externalSource.trim() === '') {
      throw new ExternalMappingError('an external mapping needs an externalSource naming whose id it is');
    }
  }
  await db
    .prepare(`UPDATE agents SET external_id = ?, external_source = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`)
    .bind(mapping?.externalId ?? null, mapping?.externalSource ?? null, agentId, tenantId)
    .run();
}

/**
 * Resolve a suite principal id back to the local agent it names.
 *
 * The reverse of `setAgentExternalMapping`: given the system and id an outside plane knows this
 * agent by, find kaambaan's own row for it. `null` for "no local agent maps to that principal" —
 * the ordinary case for every principal that isn't one of kaambaan's agents.
 */
export async function findAgentByExternal(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<{ tenantId: string; agentId: string; capabilities: string[] } | null> {
  if (!source || !externalId) return null;
  const row = await db
    .prepare(
      `SELECT tenant_id AS tenantId, id AS agentId, capabilities_json AS caps
       FROM agents WHERE external_source = ? AND external_id = ?`,
    )
    .bind(source, externalId)
    .first<{ tenantId: string; agentId: string; caps: string }>();
  if (!row) return null;
  return { tenantId: row.tenantId, agentId: row.agentId, capabilities: JSON.parse(row.caps) };
}

/** Mint a per-agent bearer token. The plaintext is returned once; only the hash is stored. */
export async function createAgentToken(db: D1Database, tenantId: string, agentId: string, scopes: string[]): Promise<{ id: string; token: string }> {
  const token = generateAgentToken();
  const id = newId('tok');
  await db
    .prepare(`INSERT INTO agent_tokens (id, tenant_id, agent_id, token_hash, scopes_json) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, tenantId, agentId, await hashToken(token), JSON.stringify(scopes))
    .run();
  return { id, token };
}

/**
 * Revoke a single per-agent bearer token. The read side already refuses a revoked token
 * (`findAgentByTokenHash` filters `WHERE at.revoked_at IS NULL`); this is the write it was
 * waiting on (charter decisions/2026-08-13-ecosystem-identity.md Decision 3).
 *
 * Revocation is per CREDENTIAL, not per agent — an agent with two tokens keeps working on the
 * one not named here; suspending the agent itself is a separate lever, built elsewhere in this
 * slice. Tenant- and agent-scoped, like every other write in this file, so one tenant can never
 * reach into another's tokens by guessing an id.
 *
 * Idempotent and silent about absence, deliberately: an operator hitting the button twice, a
 * retried request, and a token id that never existed (or belongs to someone else) all take the
 * same `UPDATE … WHERE revoked_at IS NULL` no-op path and return with no error — nothing here
 * lets a caller distinguish "already revoked" from "never existed" from "not yours".
 */
export async function revokeAgentToken(db: D1Database, tenantId: string, agentId: string, tokenId: string): Promise<void> {
  await db
    .prepare(`UPDATE agent_tokens SET revoked_at = datetime('now') WHERE id = ? AND tenant_id = ? AND agent_id = ? AND revoked_at IS NULL`)
    .bind(tokenId, tenantId, agentId)
    .run();
}

/**
 * Resolve a presented bearer token (by hash) to its agent + tenant + capabilities.
 *
 * Also returns `externalId` — the agent's mapped suite principal id, if any — straight off the
 * same JOIN this already runs against `agents`. A caller that needs the principal id (the claim
 * route, so it can match a grant by equality) gets it here instead of issuing a second D1 read
 * for a row this query already fetched.
 */
export async function findAgentByTokenHash(
  db: D1Database,
  hash: string,
): Promise<{ tenantId: string; agentId: string; scopes: string[]; capabilities: string[]; externalId: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT at.tenant_id AS tenantId, at.agent_id AS agentId, at.scopes_json AS scopes, a.capabilities_json AS caps, a.external_id AS externalId
       FROM agent_tokens at JOIN agents a ON a.id = at.agent_id
       WHERE at.token_hash = ? AND at.revoked_at IS NULL`,
    )
    .bind(hash)
    .first<{ tenantId: string; agentId: string; scopes: string; caps: string; externalId: string | null }>();
  if (!row) return null;
  return {
    tenantId: row.tenantId,
    agentId: row.agentId,
    scopes: JSON.parse(row.scopes),
    capabilities: JSON.parse(row.caps),
    externalId: row.externalId,
  };
}

// The token ids are a correlated subquery, not a JOIN: an agent with several tokens must not
// multiply into several rows, and one with none must still list (COALESCE — json_group_array
// over zero matching rows is NULL, not '[]').
export async function listAgents(db: D1Database, tenantId: string): Promise<AgentRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT id, tenant_id AS tenantId, name, capabilities_json AS caps, external_id AS externalId, external_source AS externalSource,
              COALESCE((SELECT json_group_array(t.id) FROM agent_tokens t WHERE t.agent_id = a.id AND t.revoked_at IS NULL), '[]') AS tokenIdsJson
       FROM agents a WHERE tenant_id = ? ORDER BY created_at ASC`,
    )
    .bind(tenantId)
    .all<{ id: string; tenantId: string; name: string; caps: string; externalId: string | null; externalSource: string | null; tokenIdsJson: string }>();
  return results.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    name: r.name,
    capabilities: JSON.parse(r.caps),
    externalId: r.externalId,
    externalSource: r.externalSource,
    tokenIds: JSON.parse(r.tokenIdsJson),
  }));
}

/** Index a board in the catalog so a workspace can list its boards (the DO holds the live state). */
export async function recordBoard(db: D1Database, tenantId: string, input: { id: string; name: string; stagesJson: string }): Promise<void> {
  await db
    .prepare(`INSERT INTO boards (id, tenant_id, name, stages_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = datetime('now')`)
    .bind(input.id, tenantId, input.name, input.stagesJson)
    .run();
}

export async function listBoards(db: D1Database, tenantId: string): Promise<Array<{ id: string; name: string }>> {
  const { results } = await db.prepare(`SELECT id, name FROM boards WHERE tenant_id = ? ORDER BY created_at DESC`).bind(tenantId).all<{ id: string; name: string }>();
  return results;
}

/** Rename a board's catalog row (the DO's name is updated alongside). */
export async function renameBoard(db: D1Database, tenantId: string, boardId: string, name: string): Promise<void> {
  await db.prepare(`UPDATE boards SET name = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`).bind(name, tenantId, boardId).run();
}

/** Remove a board from the catalog (tenant-scoped). The DO's live state is left untouched. */
export async function deleteBoard(db: D1Database, tenantId: string, boardId: string): Promise<void> {
  await db.prepare(`DELETE FROM boards WHERE tenant_id = ? AND id = ?`).bind(tenantId, boardId).run();
}

/** Delete an agent and its tokens (tokens first, to satisfy the FK), tenant-scoped. */
export async function deleteAgent(db: D1Database, tenantId: string, agentId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM agent_tokens WHERE tenant_id = ? AND agent_id = ?`).bind(tenantId, agentId),
    db.prepare(`DELETE FROM agents WHERE tenant_id = ? AND id = ?`).bind(tenantId, agentId),
  ]);
}

/**
 * Does this agent belong to this tenant? `setAgentExternalMapping` is itself tenant-scoped now
 * (same `WHERE id = ? AND tenant_id = ?` shape as `deleteAgent` and `revokeAgentToken`), but this
 * check stays: it is what turns a cross-tenant PATCH into a 404 instead of a silent no-op update
 * that changed nothing. Without it, a signed-in user of one tenant could hand an agent id from a
 * different tenant and get back a 200 with no idea their write did not land anywhere.
 */
export async function agentBelongsToTenant(db: D1Database, tenantId: string, agentId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM agents WHERE id = ? AND tenant_id = ?`).bind(agentId, tenantId).first();
  return row !== null;
}

/**
 * Minimal subset of the D1 query API we depend on — declared structurally so the repository can be
 * unit-tested with a fake (and so the catalog isn't coupled to a specific runtime type).
 */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
}
export interface D1StatementLike {
  bind(...params: unknown[]): D1BoundLike;
}
export interface D1BoundLike {
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

/**
 * Tenant-scoped catalog reads. Every method requires a tenantId and routes through
 * `tenantScopedSelect`, so there is no path to read another tenant's rows.
 */
export class CatalogRepository {
  constructor(private readonly db: D1Like) {}

  private run<T>(query: ScopedQuery): Promise<{ results: T[] }> {
    return this.db.prepare(query.sql).bind(...query.params).all<T>();
  }

  listBoards<T = Record<string, unknown>>(tenantId: string) {
    return this.run<T>(tenantScopedSelect('boards', tenantId));
  }

  getBoard<T = Record<string, unknown>>(tenantId: string, boardId: string) {
    return this.run<T>(tenantScopedSelect('boards', tenantId, { where: { id: boardId } }));
  }

  listAgents<T = Record<string, unknown>>(tenantId: string) {
    return this.run<T>(tenantScopedSelect('agents', tenantId));
  }
}

/**
 * The kaambaan tenant that a foreign system's id maps onto.
 *
 * Migration 0002 added `external_source` + `external_id` so the same real
 * organisation can be recognised across two products that each keep their own
 * local boundary and neither of which mints the other's ids. A hub token names
 * AgentPod's boundary (`fleet_…`); this is how that becomes a `tnt_…`.
 *
 * BOTH halves must match. An `external_id` on its own could belong to any
 * system, and matching it alone would let one system's id select a tenant
 * mapped to a different system entirely.
 *
 * Returns null when nothing is mapped, which is the normal state for a
 * standalone board and must stay workable: a caller whose tenant cannot be
 * resolved is refused, not given a default.
 */
export async function findTenantByExternal(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<string | null> {
  if (!source || !externalId) return null;
  const row = await db
    .prepare(`SELECT id FROM tenants WHERE external_source = ? AND external_id = ?`)
    .bind(source, externalId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

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
 * A tenant is superpipeline's LOCAL isolation boundary, not an authority on who anyone is. The
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
  /** This workspace's Forgejo host, bare — no scheme, no path. NULL when it runs no forge. */
  forgeHost: string | null;
}

/** Where a tenant is also known, outside superpipeline. */
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
 * A registered superpipeline agent — always addressable by its native `agt_…` id and `spa_` bearer
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
  /** An avatar for the board's card tiles. Null is ordinary — the tile falls back to an initial. */
  iconUrl: string | null;
  /**
   * How many cards this agent may hold at once. The column has existed since migration 0001 and
   * was never read; it is the default `maxConcurrency` at claim time, which an agent's own claim
   * request may still lower but not raise beyond what its operator set here.
   */
  concurrency: number;
  externalId: string | null;
  externalSource: string | null;
  /**
   * Ids of this agent's active (non-revoked) `spa_` tokens — what the console needs to offer a
   * "revoke" action without holding onto the one-time plaintext-mint response. Empty is a real,
   * complete state (an agent with nothing active cannot authenticate until reconnected), not an
   * omission.
   */
  tokenIds: string[];
}

/** An agent record, plus what bounds it when it queues work of its own (migration 0015). */
export type AgentRecordWithQueueing = AgentRecord & AgentQueueingPolicy;

/** Where an agent is also known, as a suite principal outside superpipeline. */
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
  // No external mapping: a personal workspace answers to nothing outside superpipeline, and that is a
  // complete tenant. A mapping is recorded later, by whoever links this boundary to an org.
  const tenant: TenantRecord = {
    id,
    slug: `${slugify(displayName)}-${id.slice(-6)}`,
    name: `${displayName}'s workspace`,
    externalId: null,
    externalSource: null,
    // A new workspace runs no forge. Every self-hosted URL stays a generic `url` reference until
    // somebody says otherwise, which is the safe default: not recognising a link is recoverable,
    // labelling somebody else's server as this tenant's repository is not.
    forgeHost: null,
  };
  await db.prepare(`INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)`).bind(tenant.id, tenant.slug, tenant.name).run();
  await db.prepare(`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, 'owner')`).bind(newId('mbr'), id, userId).run();
  return tenant;
}

export async function primaryTenant(db: D1Database, userId: string): Promise<TenantRecord | null> {
  return db
    .prepare(
      `SELECT t.id, t.slug, t.name, t.external_id AS externalId, t.external_source AS externalSource,
              t.forge_host AS forgeHost
       FROM tenants t JOIN memberships m ON m.tenant_id = t.id WHERE m.user_id = ? ORDER BY m.created_at ASC LIMIT 1`,
    )
    .bind(userId)
    .first<TenantRecord>();
}

/**
 * One workspace by id, mapping and all.
 *
 * `primaryTenant` above answers "which workspace is this person's", keyed by user. This answers
 * "what is this workspace", keyed by the tenant a request has already resolved to — which is what
 * `GET /v1/tenant` needs in order to show an operator whether their workspace is linked to a hub
 * fleet, and to which one.
 */
export async function tenantById(db: D1Database, tenantId: string): Promise<TenantRecord | null> {
  return db
    .prepare(
      `SELECT id, slug, name, external_id AS externalId, external_source AS externalSource,
              forge_host AS forgeHost
       FROM tenants WHERE id = ?`,
    )
    .bind(tenantId)
    .first<TenantRecord>();
}

/**
 * Record (or clear, with `null`) which host is this workspace's forge.
 *
 * A HOST, not a URL. It is compared against a parsed URL's `hostname`, so a scheme or a trailing
 * path would simply never match and the setting would look configured while doing nothing —
 * which is worse than an error, because nothing reports it. The normalisation here is the
 * same one recognition applies, so what is stored is what will be compared.
 */
export async function setTenantForgeHost(db: D1Database, tenantId: string, host: string | null): Promise<void> {
  let value: string | null = null;
  if (host !== null) {
    const trimmed = host.trim();
    // Accept what a person is likely to paste — `https://forge.example/` — and store the host.
    // Refusing it would be defensible; quietly storing it would not.
    let parsed = trimmed;
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        parsed = new URL(trimmed).hostname;
      } catch {
        throw new Error(`not a host: ${host}`);
      }
    }
    parsed = parsed.replace(/\/.*$/, '').toLowerCase().replace(/^www\./, '');
    if (!parsed || parsed.includes(' ')) throw new Error(`not a host: ${host}`);
    value = parsed;
  }
  await db.prepare(`UPDATE tenants SET forge_host = ?, updated_at = datetime('now') WHERE id = ?`).bind(value, tenantId).run();
}

/**
 * Record (or clear, with `null`) where this tenant is also known outside superpipeline.
 *
 * The pair is all-or-nothing and the database enforces it (`tenants_external_pair`); this guard
 * exists so the failure names the mistake instead of surfacing as a SQLITE_CONSTRAINT. Recording
 * an id without the system it came from is worse than recording nothing: an unattributed id
 * cannot be joined against anything, and a wrong join is harder to notice than a missing one.
 *
 * **Corrected 2026-08-31.** This used to say "nothing calls this yet", and the whole-branch
 * review found that still true long after it mattered: `resolveHubUser` and `resolveHubAgent`
 * BOTH require `findTenantByExternal(db, 'agentpod', claims.tenant)` to resolve before a
 * hub-issued credential can do anything in superpipeline, and nothing wrote that row — so it existed
 * only where somebody had made it by hand, which is "no SQL at any point" broken at the seam
 * between the two repositories.
 *
 * The one caller is `PATCH /v1/tenant` (index.ts), the deliberate mirror of `PATCH
 * /v1/agents/:id`: a human validates the `fleet_[0-9a-f]{20}` shape and calls this. It changes no
 * existing behaviour on its own — a workspace nobody has linked is exactly the workspace
 * superpipeline has today, and that stays the normal state for a standalone board.
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

/**
 * The user an issuer subject is, in this workspace. Null when nobody has linked it.
 *
 * `externalId` is the hub token's `sub` — today a Better Auth user id, not a
 * `prn_…` principal id (the hub's jwt plugin overwrites `sub` with
 * `session.user.id` after building the payload). Two ids for one human exist
 * upstream and only this one ever reaches this table; the consequence is
 * recorded as an open question in the suite-sign-in spec.
 */
export async function findUserByExternal(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<UserRecord | null> {
  if (!source || !externalId) return null;
  return db
    .prepare(`SELECT id, email, name FROM users WHERE external_source = ? AND external_id = ?`)
    .bind(source, externalId)
    .first<UserRecord>();
}

/** Record that this user is also known to `externalSource` as the subject `externalId`. */
export async function setUserExternalMapping(
  db: D1Database,
  userId: string,
  mapping: { externalId: string; externalSource: string } | null,
): Promise<void> {
  if (mapping) {
    const { externalId, externalSource } = mapping;
    if (typeof externalId !== 'string' || externalId.trim() === '') {
      throw new ExternalMappingError('an external mapping needs an externalId');
    }
    if (typeof externalSource !== 'string' || externalSource.trim() === '') {
      throw new ExternalMappingError('an external mapping needs an externalSource naming whose id it is');
    }
  }
  await db
    .prepare(`UPDATE users SET external_id = ?, external_source = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(mapping?.externalId ?? null, mapping?.externalSource ?? null, userId)
    .run();
}

/**
 * A user by email, for the one-time adoption in the hub callback.
 *
 * Deliberately NOT `upsertUserByEmail`, which CREATES when it does not find —
 * using it as a lookup would conjure a user as a side effect of asking whether
 * one exists. And it selects `external_id`, because the caller's guard is
 * "adopt only a user who has no mapping", and a guard reading an undefined
 * column silently adopts everybody.
 *
 * **`COLLATE NOCASE`, because the caller can only fold its own side.**
 * `hub-oauth.ts` lowercases and trims the asserted address, but `auth/routes.ts`
 * stores `ghUser.email` VERBATIM and GitHub returns it as the person typed it.
 * A BINARY `WHERE email = ?` therefore misses a GitHub-created row holding
 * `Rakesh.Gangwar@Example.com`, the caller's `candidate` comes back null, and
 * its create step inserts a SECOND user and a second personal workspace for one
 * person — the UNIQUE on `users.email` is BINARY too, so nothing stops it. That
 * is the same harm the claim-canonicalisation fix prevented, arriving from the
 * other side.
 *
 * **`ORDER BY created_at LIMIT 1` because two such rows may ALREADY coexist.**
 * Nothing before this stopped one being written, so a deployment can be holding
 * a GitHub-verbatim row and a hub-lowercased row for one address; folding the
 * comparison makes both match at once and `.first()` would otherwise return
 * whichever the query planner reached first. Oldest wins: that is the account
 * the person has actually been using, and a stable answer means adoption cannot
 * land on a different row on a later attempt. Merging such a pair is a data
 * repair, not something a lookup may do.
 */
export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<(UserRecord & { externalId: string | null }) | null> {
  if (!email) return null;
  return db
    .prepare(
      `SELECT id, email, name, external_id AS externalId FROM users
        WHERE email = ? COLLATE NOCASE
        ORDER BY created_at LIMIT 1`,
    )
    .bind(email)
    .first<UserRecord & { externalId: string | null }>();
}

export async function createAgent(db: D1Database, tenantId: string, input: { name: string; capabilities?: string[] }): Promise<AgentRecord> {
  const id = newId('agt');
  const capabilities = input.capabilities ?? [];
  await db.prepare(`INSERT INTO agents (id, tenant_id, name, capabilities_json) VALUES (?, ?, ?, ?)`).bind(id, tenantId, input.name, JSON.stringify(capabilities)).run();
  // No external mapping: a freshly registered agent answers to nothing outside superpipeline, and
  // that is a complete agent. A mapping is recorded later, by whoever links it to a principal.
  // No tokens either — this function mints none; the REST route mints one right after.
  return { id, tenantId, name: input.name, capabilities, iconUrl: null, concurrency: 1, externalId: null, externalSource: null, tokenIds: [] };
}

/**
 * Change an agent's own properties, after it exists.
 *
 * Until this, `capabilities_json` was written exactly once, in the INSERT inside `createAgent`,
 * and nothing anywhere could change it: the only remedy for a wrong capability set was to delete
 * the agent and make another — which, for a linked agent, discards its principal link too. The
 * shipped board templates need `code`, `test`, `deploy`, `triage`, so an agent staffed with the
 * wrong set could not be moved to the right one.
 *
 * Partial by construction: an omitted field is left alone rather than blanked, so a caller
 * changing an icon cannot silently erase a capability set it never mentioned. `iconUrl` is the
 * one field where `null` is a value (clear it) rather than an omission, which is why it is
 * compared against `undefined`.
 *
 * Tenant-scoped for the reason `setAgentExternalMapping` gives: `agents.id` is a bare primary key
 * with no per-tenant uniqueness, so the `WHERE` clause is the defence, not the caller's check.
 */
export async function updateAgent(
  db: D1Database,
  tenantId: string,
  agentId: string,
  patch: {
    name?: string;
    capabilities?: string[];
    iconUrl?: string | null;
    concurrency?: number;
    /**
     * The queueing policy (migration 0015). Here rather than in a setter of its own because two
     * writers for one table is how they drift — and because this is the route an operator already
     * uses to say what an agent IS.
     */
    ownerUserId?: string | null;
    mayQueueTo?: string[] | null;
    queueCeilingPerHour?: number;
    boardCeilingPerDay?: number;
  },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.capabilities !== undefined) {
    sets.push('capabilities_json = ?');
    vals.push(JSON.stringify(patch.capabilities));
  }
  if (patch.iconUrl !== undefined) {
    sets.push('icon_url = ?');
    vals.push(patch.iconUrl);
  }
  if (patch.concurrency !== undefined) {
    sets.push('concurrency = ?');
    vals.push(patch.concurrency);
  }
  // `'x' in patch` rather than `!== undefined`: null is a MEANINGFUL value for both of these — it
  // clears the owner, and it returns the allowlist to "no board" — so an explicit null must reach
  // the UPDATE rather than being read as "not mentioned".
  if ('ownerUserId' in patch) {
    sets.push('owner_user_id = ?');
    vals.push(patch.ownerUserId ?? null);
  }
  if ('mayQueueTo' in patch) {
    sets.push('may_queue_to_json = ?');
    vals.push(patch.mayQueueTo === null || patch.mayQueueTo === undefined ? null : JSON.stringify(patch.mayQueueTo));
  }
  if (patch.queueCeilingPerHour !== undefined) {
    sets.push('queue_ceiling_per_hour = ?');
    vals.push(patch.queueCeilingPerHour);
  }
  if (patch.boardCeilingPerDay !== undefined) {
    sets.push('board_ceiling_per_day = ?');
    vals.push(patch.boardCeilingPerDay);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = datetime('now')`);
  await db
    .prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`)
    .bind(...vals, agentId, tenantId)
    .run();
}

/**
 * Record (or clear, with `null`) where this agent is also known, as a suite principal, outside
 * superpipeline. Mirrors `setTenantExternalMapping` exactly — same all-or-nothing guard, same
 * database-enforced CHECK (`agents_external_pair`, migration 0003) backing it up.
 *
 * **Corrected 2026-08-31.** This used to say "nothing calls this yet". The one caller is
 * `PATCH /v1/agents/:id` (index.ts): a human validates the `prn_[0-9a-f]{20}` shape and calls
 * this. It is what lets `resolveHubAgent` turn an agent-kind hub token into a local agent — until
 * a mapping is recorded, there is nothing for that resolver to find. It changes no existing
 * behaviour on its own: an agent nobody has linked is exactly the agent superpipeline has today.
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
 * agent by, find superpipeline's own row for it. `null` for "no local agent maps to that principal" —
 * the ordinary case for every principal that isn't one of superpipeline's agents.
 */
export async function findAgentByExternal(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<({ tenantId: string; agentId: string; capabilities: string[]; concurrency: number } & AgentQueueingPolicy) | null> {
  if (!source || !externalId) return null;
  const row = await db
    .prepare(
      `SELECT tenant_id AS tenantId, id AS agentId, capabilities_json AS caps, concurrency,
              owner_user_id AS ownerUserId, may_queue_to_json AS mayQueueTo, queue_ceiling_per_hour AS ceiling,
              board_ceiling_per_day AS boardCeiling
       FROM agents WHERE external_source = ? AND external_id = ?`,
    )
    .bind(source, externalId)
    .first<{ tenantId: string; agentId: string; caps: string; concurrency: number; ownerUserId: string | null; mayQueueTo: string | null; ceiling: number | null; boardCeiling: number | null }>();
  if (!row) return null;
  return {
    tenantId: row.tenantId,
    agentId: row.agentId,
    capabilities: JSON.parse(row.caps),
    concurrency: row.concurrency,
    ...queueingPolicyOf(row),
  };
}

/** The suite's principal grammar (agentpod `id_grammar.json` → `agentpod.principal`). */
const PRINCIPAL_ID = /^prn_[0-9a-f]{20}$/;

/** The distinct, non-empty strings of a list that may hold nulls. */
function distinctIds(localIds: Array<string | null>): string[] {
  return [...new Set(localIds.filter((v): v is string => typeof v === 'string' && v !== ''))];
}

/**
 * Local user id → the id the suite knows that user by (`users.external_id`, source `agentpod` or
 * `org-plane` — an org-plane id is always a `prn_`). Linked users only.
 */
async function userExternalIds(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(`SELECT id, external_id FROM users WHERE external_source IN ('agentpod', 'org-plane') AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<{ id: string; external_id: string }>();
  for (const r of results) out.set(r.id, r.external_id);
  return out;
}

/**
 * Local ids → suite principal ids, for evidence (superwitness contract C4). Returns only what
 * resolves to a `prn_…`; a caller reads a missing key as `null`, never as a guess.
 *
 *   - `agt_…` → `agents.external_id` where `external_source = 'org-plane'`, in THIS tenant.
 *   - any other local id → `users.external_id` where `external_source = 'agentpod'`, but only
 *     when that value is `prn_`-shaped. It is usually a Better Auth user id (migration 0008's
 *     header explains why), which is not a principal and is therefore left out.
 *   - a value that already IS a `prn_…` (an unlinked station- or bridge-minted token's `sub`)
 *     maps to itself.
 */
export async function principalIdsFor(
  db: D1Database,
  tenantId: string,
  localIds: Array<string | null>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = distinctIds(localIds);
  for (const id of ids) if (PRINCIPAL_ID.test(id)) out.set(id, id);

  const agentIds = ids.filter((v) => v.startsWith('agt_'));
  if (agentIds.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT id, external_id FROM agents
          WHERE tenant_id = ? AND external_source = 'org-plane' AND id IN (${agentIds.map(() => '?').join(',')})`,
      )
      .bind(tenantId, ...agentIds)
      .all<{ id: string; external_id: string }>();
    for (const r of results) if (PRINCIPAL_ID.test(r.external_id)) out.set(r.id, r.external_id);
  }

  const userIds = ids.filter((v) => !v.startsWith('agt_') && !PRINCIPAL_ID.test(v));
  for (const [id, ext] of await userExternalIds(db, userIds)) if (PRINCIPAL_ID.test(ext)) out.set(id, ext);
  return out;
}

/**
 * Display names for this tenant's agents, for the superwitness run reporter's `executor.name`.
 * Ids with no row are absent; the caller falls back to the local id.
 */
export async function agentNamesFor(db: D1Database, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const agentIds = distinctIds(ids).filter((v) => v.startsWith('agt_'));
  if (agentIds.length === 0) return out;
  const { results } = await db
    .prepare(`SELECT id, name FROM agents WHERE tenant_id = ? AND id IN (${agentIds.map(() => '?').join(',')})`)
    .bind(tenantId, ...agentIds)
    .all<{ id: string; name: string }>();
  for (const r of results) out.set(r.id, r.name);
  return out;
}

/**
 * Local ids → the hub token `sub` the person is known by, when that `sub` is NOT a principal id
 * (C4 `gates[].decided_by_hub_sub`). superwitness hands it to the hub's principals route, which
 * resolves it through `principal_identities`.
 *
 *   - `usr_…` → `users.external_id` where `external_source = 'agentpod'`, unless it is a `prn_…`
 *     (then `principalIdsFor` already answered).
 *   - a value that is none of `usr_…`, `agt_…`, `prn_…` IS a hub `sub`: `resolveHubUser` stores
 *     `claims.sub` as the user id when no local user is linked.
 */
export async function hubSubjectsFor(db: D1Database, localIds: Array<string | null>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = distinctIds(localIds).filter((v) => !v.startsWith('agt_') && !PRINCIPAL_ID.test(v));
  for (const id of ids) if (!id.startsWith('usr_')) out.set(id, id);

  const userIds = ids.filter((v) => v.startsWith('usr_'));
  for (const [id, ext] of await userExternalIds(db, userIds)) if (!PRINCIPAL_ID.test(ext)) out.set(id, ext);
  return out;
}

/**
 * What bounds an agent that queues work of its own (migration 0015).
 *
 * The dispatch grant is deliberately absent. It is AgentPod's — `fleet grants set` — and arrives
 * in a token's claims, so a copy here would be a second source of truth that keeps permitting a
 * dispatch after the operator revoked it.
 */
export interface AgentQueueingPolicy {
  /** The human an agent-queued card belongs to. Null means this agent may not queue at all. */
  ownerUserId: string | null;
  /**
   * Board ids this agent may queue onto. **Null means NONE**, not "all": an agent that gains the
   * scope without the operator naming a board must be able to create exactly zero cards.
   *
   * An empty array means the same thing by a different route, and the difference is worth keeping
   * — one is "nobody has decided", the other is "somebody decided no" — the same distinction
   * `queued_grant` draws between a missing grant and an empty one.
   */
  mayQueueTo: string[] | null;
  /** Cards per hour. A scope bounds whether; only this bounds how much. */
  queueCeilingPerHour: number;
  /**
   * Boards per DAY. A day because boards are rare where cards are hourly, and because the hazard is
   * a loop making five hundred of them rather than one agent making three.
   */
  boardCeilingPerDay: number;
}

/** The three queueing columns, off a row that already selected them under these aliases. */
function queueingPolicyOf(row: {
  ownerUserId: string | null;
  mayQueueTo: string | null;
  ceiling: number | null;
  boardCeiling?: number | null;
}): AgentQueueingPolicy {
  return {
    ownerUserId: row.ownerUserId ?? null,
    // `JSON.parse(null)` is `null` by accident rather than by intent, so the absence is tested for
    // rather than relied on.
    mayQueueTo: row.mayQueueTo === null ? null : (JSON.parse(row.mayQueueTo) as string[]),
    queueCeilingPerHour: Number(row.ceiling ?? 20),
    boardCeilingPerDay: Number(row.boardCeiling ?? 3),
  };
}

/**
 * Write down that an agent queued a card.
 *
 * Two jobs in one row: it is what the hourly ceiling counts, and it is the only place an operator
 * can ask "what has this agent asked for today" without opening every board. Cards live in
 * per-board Durable Objects, so counting them instead would be a fan-out over ten of them.
 */
export async function recordAgentQueue(
  db: D1Database,
  input: { tenantId: string; agentId: string; boardId: string; cardId: string },
): Promise<void> {
  await db
    .prepare(`INSERT INTO agent_card_queues (id, tenant_id, agent_id, board_id, card_id) VALUES (?, ?, ?, ?, ?)`)
    .bind(newId('aqu'), input.tenantId, input.agentId, input.boardId, input.cardId)
    .run();
}

/**
 * How many cards this agent has queued since `sinceIso`.
 *
 * A moving window, not a counter: the caller passes "an hour ago" on every request, so an agent
 * that hits the ceiling recovers as the hour rolls rather than being refused forever.
 *
 * `datetime(?)` rather than a bare `?`, and the difference is a ceiling that works against one
 * that never fires. `created_at` defaults to `datetime('now')`, which SQLite writes as
 * `2026-10-02 10:45:00` — a SPACE, and no zone. An ISO bound is `2026-10-02T09:45:00.000Z`, and
 * these are compared as TEXT: `' '` sorts below `'T'`, so every row read as older than any bound
 * and the count was always zero. A rate limit that counts nothing is not a loose rate limit, it is
 * an absent one, and it fails in the direction that grants more. Normalising the bound into
 * SQLite's own spelling puts both sides in one format.
 */
export async function countAgentQueuesSince(db: D1Database, agentId: string, sinceIso: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM agent_card_queues WHERE agent_id = ? AND created_at >= datetime(?)`)
    .bind(agentId, sinceIso)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
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
): Promise<
  | ({ tenantId: string; agentId: string; scopes: string[]; capabilities: string[]; externalId: string | null; concurrency: number } & AgentQueueingPolicy)
  | null
> {
  const row = await db
    .prepare(
      `SELECT at.tenant_id AS tenantId, at.agent_id AS agentId, at.scopes_json AS scopes, a.capabilities_json AS caps,
              a.external_id AS externalId, a.concurrency AS concurrency,
              a.owner_user_id AS ownerUserId, a.may_queue_to_json AS mayQueueTo, a.queue_ceiling_per_hour AS ceiling,
              a.board_ceiling_per_day AS boardCeiling
       FROM agent_tokens at JOIN agents a ON a.id = at.agent_id
       WHERE at.token_hash = ? AND at.revoked_at IS NULL`,
    )
    .bind(hash)
    .first<{ tenantId: string; agentId: string; scopes: string; caps: string; externalId: string | null; concurrency: number; ownerUserId: string | null; mayQueueTo: string | null; ceiling: number | null; boardCeiling: number | null }>();
  if (!row) return null;
  return {
    tenantId: row.tenantId,
    agentId: row.agentId,
    scopes: JSON.parse(row.scopes),
    capabilities: JSON.parse(row.caps),
    externalId: row.externalId,
    concurrency: Number(row.concurrency ?? 1),
    ...queueingPolicyOf(row),
  };
}

// The token ids are a correlated subquery, not a JOIN: an agent with several tokens must not
// multiply into several rows, and one with none must still list (COALESCE — json_group_array
// over zero matching rows is NULL, not '[]').
export async function listAgents(db: D1Database, tenantId: string): Promise<AgentRecordWithQueueing[]> {
  const { results } = await db
    .prepare(
      `SELECT id, tenant_id AS tenantId, name, capabilities_json AS caps, icon_url AS iconUrl, concurrency,
              external_id AS externalId, external_source AS externalSource,
              owner_user_id AS ownerUserId, may_queue_to_json AS mayQueueTo, queue_ceiling_per_hour AS ceiling,
              COALESCE((SELECT json_group_array(t.id) FROM agent_tokens t WHERE t.agent_id = a.id AND t.revoked_at IS NULL), '[]') AS tokenIdsJson
       FROM agents a WHERE tenant_id = ? ORDER BY created_at ASC`,
    )
    .bind(tenantId)
    .all<{ id: string; tenantId: string; name: string; caps: string; iconUrl: string | null; concurrency: number; externalId: string | null; externalSource: string | null; ownerUserId: string | null; mayQueueTo: string | null; ceiling: number | null; tokenIdsJson: string }>();
  return results.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    name: r.name,
    capabilities: JSON.parse(r.caps),
    iconUrl: r.iconUrl,
    concurrency: Number(r.concurrency ?? 1),
    externalId: r.externalId,
    externalSource: r.externalSource,
    tokenIds: JSON.parse(r.tokenIdsJson),
    // Reported, not just stored. A permission an operator can set and cannot see is one nobody
    // audits — and `mayQueueTo` in particular is the difference between a coordinator that can put
    // work on ten boards and one that can put it nowhere.
    ...queueingPolicyOf(r),
  }));
}

/** Index a board in the catalog so a workspace can list its boards (the DO holds the live state). */
/**
 * How many boards this agent has composed since midnight UTC.
 *
 * Counted from `boards.created_by_agent_id`, so the provenance column IS the ledger — there is no
 * second table to keep in step with it, and the number can never disagree with the boards that exist.
 *
 * `date('now')` is midnight UTC, which is a real choice: a rolling 24 hours would be kinder to an
 * agent that composed three boards late yesterday, and a calendar day is what an operator reading
 * "three a day" expects. Comparison uses `datetime(...)` for the reason
 * `countAgentQueuesSince` records: `created_at` is written by `datetime('now')` and an ISO bound
 * sorts below it as text.
 */
export async function countBoardsComposedToday(db: D1Database, agentId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM boards WHERE created_by_agent_id = ? AND created_at >= datetime(date('now'))`,
    )
    .bind(agentId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function recordBoard(
  db: D1Database,
  tenantId: string,
  input: { id: string; name: string; stagesJson: string; createdBy?: string | null; createdByAgentId?: string | null },
): Promise<void> {
  await db
    .prepare(
      // The creator is set on INSERT only, never on the conflict path: this doubles as the board's
      // rename/re-index writer, and a later rename must not rewrite who made it.
      `INSERT INTO boards (id, tenant_id, name, stages_json, created_by, created_by_agent_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = datetime('now')`,
    )
    .bind(input.id, tenantId, input.name, input.stagesJson, input.createdBy ?? null, input.createdByAgentId ?? null)
    .run();
}

export async function listBoards(db: D1Database, tenantId: string): Promise<Array<{ id: string; name: string }>> {
  // Through `tenantScopedSelect`, not around it. The guard's whole claim is that "there is NO
  // unscoped query builder" — and until this, every production read was hand-written SQL and the
  // builder was used only by its own tests. A guard nothing routes through guards nothing.
  const q = tenantScopedSelect('boards', tenantId, { columns: ['id', 'name'] });
  const { results } = await db.prepare(`${q.sql} ORDER BY created_at DESC`).bind(...q.params).all<{ id: string; name: string }>();
  return results;
}

/**
 * Every board in the deployment, tenant and all.
 *
 * **Deliberately unscoped, and named so.** Every other read here takes a tenantId because it
 * answers a question somebody asked; this one exists for the scheduled sweep, which has no
 * caller and therefore no tenant. Fabricating one would be worse than admitting there is none:
 * the sweep would silently drain one workspace's delivery queue and no other.
 *
 * Not exported through any route. The only caller is `scheduled()`.
 */
export async function listAllBoards(db: D1Database): Promise<Array<{ id: string; tenantId: string }>> {
  const { results } = await db
    .prepare(`SELECT id, tenant_id AS tenantId FROM boards ORDER BY created_at ASC`)
    .all<{ id: string; tenantId: string }>();
  return results;
}

/** Rename a board's catalog row (the DO's name is updated alongside). */
export async function renameBoard(db: D1Database, tenantId: string, boardId: string, name: string): Promise<void> {
  await db.prepare(`UPDATE boards SET name = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`).bind(name, tenantId, boardId).run();
}

/**
 * Mirror a reworked pipeline into the catalog row.
 *
 * `boards.stages_json` is a copy: the Durable Object holds the live definition and every claim
 * reads it from there. The copy exists so a board can be listed and described without waking its
 * DO, which means a stale copy is a board that DESCRIBES itself wrongly — hence this writer, and
 * hence the route calling it only after the DO has accepted the change.
 */
export async function updateBoardStages(db: D1Database, tenantId: string, boardId: string, stagesJson: string): Promise<void> {
  await db.prepare(`UPDATE boards SET stages_json = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`).bind(stagesJson, tenantId, boardId).run();
}

/**
 * Remove a board from the catalog (tenant-scoped), and any cross-board advisory edges that
 * reference it — from EITHER end. The DO's live state is left untouched; this is D1 only.
 *
 * Migration 0012 gave `boards(id)` its first (and, so far, only) foreign key —
 * `card_links_external.from_board_id`/`to_board_id`, with no `ON DELETE` clause — so a bare
 * `DELETE FROM boards` now throws whenever any advisory edge names this board, from either side.
 * That failure lands on the SECOND half of the route's delete (`index.ts`): `stub.destroy()` runs
 * first and cannot be undone, so a D1 delete that can still fail leaves the board's Durable Object
 * already wiped while its catalog row survives — gone from its own contents, still listed, and
 * undeletable on every retry, since retrying does not change the row that is blocking it.
 *
 * The fix is to make THIS delete unable to fail on that FK, not to reorder the route: reordering
 * only moves the damage (a failing `destroy()` after a successful D1 delete would orphan the DO
 * instead — billing and invisible — which is the exact failure mode the route's own ordering was
 * written to avoid). One `db.batch`, children first, same convention as `deleteAgent` just above:
 * either both deletes land, or neither does, so there is no window where one half succeeded and
 * the FK could still fire on the other.
 */
export async function deleteBoard(db: D1Database, tenantId: string, boardId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM card_links_external WHERE tenant_id = ? AND (from_board_id = ? OR to_board_id = ?)`).bind(tenantId, boardId, boardId),
    db.prepare(`DELETE FROM boards WHERE tenant_id = ? AND id = ?`).bind(tenantId, boardId),
  ]);
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
  const q = tenantScopedSelect('agents', tenantId, { columns: ['id'], where: { id: agentId } });
  const row = await db.prepare(q.sql).bind(...q.params).first();
  return row !== null;
}

/**
 * The superpipeline tenant that a foreign system's id maps onto.
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

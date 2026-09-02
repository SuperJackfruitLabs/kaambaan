import { env } from 'cloudflare:test';
import tenantExternalMapping from '../../migrations/0002_tenant_external_mapping.sql?raw';
import agentExternalMapping from '../../migrations/0003_agent_external_mapping.sql?raw';
import agentExternalPairUnique from '../../migrations/0004_agent_external_pair_unique.sql?raw';
import dropUnused from '../../migrations/0005_drop_unused.sql?raw';

/** Create the catalog tables on the test D1 (mirrors migrations/0001_catalog.sql). */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, UNIQUE(tenant_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, stages_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, icon_url TEXT, capabilities_json TEXT NOT NULL DEFAULT '[]', connection_json TEXT NOT NULL DEFAULT '["rest"]', concurrency INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'offline', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT)`,
];

/** Strip `--` comment lines and split a migration file into executable statements. */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Has this migration already run? (Storage may persist across `beforeAll`s within a file.) */
async function tableHasColumn(table: string, column: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .bind(table)
    .first<{ sql: string }>();
  return Boolean(row?.sql?.includes(column));
}

/** Has this index already been created? Same "storage may persist across beforeAll's" guard. */
async function indexExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).bind(name).first();
  return row !== null;
}

export async function setupCatalog(): Promise<void> {
  for (const s of STATEMENTS) await env.DB.prepare(s).run();
  // Run the REAL migrations rather than hand-copied mirrors, so the CHECK constraints the suite
  // exercises are byte-identical to what ships. A mirror is how the schema this helper already
  // carries drifted from 0001_catalog.sql in the first place.
  if (!(await tableHasColumn('tenants', 'external_id'))) {
    for (const s of statementsOf(tenantExternalMapping)) await env.DB.prepare(s).run();
  }
  if (!(await tableHasColumn('agents', 'external_id'))) {
    for (const s of statementsOf(agentExternalMapping)) await env.DB.prepare(s).run();
  }
  if (!(await indexExists('agents_external_pair_unique'))) {
    for (const s of statementsOf(agentExternalPairUnique)) await env.DB.prepare(s).run();
  }
  // 0005 drops columns the mirror above still creates, so the suite runs against the schema that
  // ships rather than the one this helper remembers. That is the whole point of running the real
  // files: a mirror is how this helper drifted from 0001 in the first place.
  if (await tableHasColumn('agents', 'connection_json')) {
    for (const s of statementsOf(dropUnused)) await env.DB.prepare(s).run();
  }
}

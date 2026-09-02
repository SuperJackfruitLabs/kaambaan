import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import capabilitiesMigration from '../migrations/0006_capabilities.sql?raw';

/**
 * Migration 0006 run for real — its tenant foreign key and its backfill, neither of which the
 * suite's mirror of the catalog carries.
 *
 * **Its own file, deliberately.** The Workers pool isolates D1 per test FILE, not per test, so
 * every board and agent an earlier test created is still present when a later one runs. Those are
 * made under dev-header tenants that have no `tenants` row, and the backfill would try to give
 * them capabilities and trip the very foreign key this file exists to prove.
 */
describe('migration 0006, run for real', () => {
  const TENANT = 'tnt_mig_0006';

  beforeEach(async () => {
    await env.DB.prepare(`DROP TABLE IF EXISTS capabilities`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'M')`).bind(TENANT, 'mig-0006').run();
    await env.DB.prepare(`INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES (?, ?, 'B', ?)`)
      .bind('brd_mig', TENANT, JSON.stringify([
        { key: 'code', name: 'Code', order: 0, ownerKind: 'capability', owner: 'code' },
        { key: 'sign', name: 'Sign off', order: 1, ownerKind: 'human' },
      ]))
      .run();
    await env.DB.prepare(`INSERT OR IGNORE INTO agents (id, tenant_id, name, capabilities_json) VALUES (?, ?, 'A', ?)`)
      .bind('agt_mig', TENANT, JSON.stringify(['code', 'claim']))
      .run();
  });

  function statementsOf(sql: string): string[] {
    return sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  it('backfills from the boards and agents already in the catalog', async () => {
    for (const s of statementsOf(capabilitiesMigration)) await env.DB.prepare(s).run();

    const { results } = await env.DB.prepare(`SELECT key, origin FROM capabilities WHERE tenant_id = ? ORDER BY key`).bind(TENANT).all<{ key: string; origin: string }>();
    // `code` from both a stage and an agent, deduplicated by UNIQUE(tenant_id, key);
    // `claim` from the agent alone — the shape of the bug, now visible.
    expect(results.map((r) => r.key)).toEqual(['claim', 'code']);
    // Nobody declared these. They accumulated, which is exactly what the column records.
    expect(results.every((r) => r.origin === 'inferred')).toBe(true);
  });

  it('carries the tenant foreign key the suite mirror drops', async () => {
    for (const s of statementsOf(capabilitiesMigration)) await env.DB.prepare(s).run();
    await expect(
      env.DB.prepare(`INSERT INTO capabilities (id, tenant_id, key, name) VALUES ('cap_x', 'tnt_nonexistent', 'k', 'k')`).run(),
    ).rejects.toThrow();
  });
});

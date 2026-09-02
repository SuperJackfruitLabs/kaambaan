import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { listBoards, listAgents, agentBelongsToTenant, recordBoard, createAgent } from '../src/db/catalog';
import { tenantScopedSelect, TenantIsolationError, TENANT_SCOPED_TABLES } from '../src/db/tenant-scope';

/**
 * Tenant isolation, tested against the readers production actually uses.
 *
 * This file used to drive `CatalogRepository` — a class wrapping three `tenantScopedSelect` calls
 * that nothing ever constructed. So the guard was proven by its own test and bypassed by every
 * real query, which is the worst of both: a claim in `tenant-scope.ts` that "there is NO unscoped
 * query builder", and a codebase where every production read was hand-written SQL. The class is
 * gone and the readers now route through the builder, so these assertions bear on the code that
 * runs.
 */

const A = 'tnt_iso_a';
const B = 'tnt_iso_b';

beforeEach(async () => {
  for (const t of [A, B]) {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'Iso')`).bind(t, `slug-${t}`).run();
  }
});

describe('a tenant sees its own rows and no others', () => {
  it('lists only this tenant\'s boards', async () => {
    await recordBoard(env.DB, A, { id: 'brd_iso_a', name: 'Mine', stagesJson: '[]' });
    await recordBoard(env.DB, B, { id: 'brd_iso_b', name: 'Theirs', stagesJson: '[]' });

    expect((await listBoards(env.DB, A)).map((b) => b.id)).toEqual(['brd_iso_a']);
    expect((await listBoards(env.DB, B)).map((b) => b.id)).toEqual(['brd_iso_b']);
  });

  it('lists only this tenant\'s agents', async () => {
    const mine = await createAgent(env.DB, A, { name: 'Mine' });
    await createAgent(env.DB, B, { name: 'Theirs' });

    expect((await listAgents(env.DB, A)).map((a) => a.id)).toEqual([mine.id]);
  });

  it('will not confirm another tenant\'s agent as its own', async () => {
    const theirs = await createAgent(env.DB, B, { name: 'Theirs' });
    expect(await agentBelongsToTenant(env.DB, B, theirs.id)).toBe(true);
    expect(await agentBelongsToTenant(env.DB, A, theirs.id)).toBe(false);
  });
});

describe('the builder refuses to produce a query that could cross a tenant', () => {
  it('puts tenant_id first, bound first', () => {
    const q = tenantScopedSelect('agents', A, { columns: ['id'], where: { id: 'agt_1' } });
    expect(q.sql).toContain('WHERE tenant_id = ?');
    expect(q.params).toEqual([A, 'agt_1']);
  });

  it('refuses an empty tenant rather than selecting everything', () => {
    expect(() => tenantScopedSelect('boards', '')).toThrow(TenantIsolationError);
    expect(() => tenantScopedSelect('boards', '   ')).toThrow(TenantIsolationError);
  });

  it('refuses a table nobody registered as tenant-scoped', () => {
    expect(() => tenantScopedSelect('users', A)).toThrow(TenantIsolationError);
    // `webhooks` was on this list until the table it named was dropped in migration 0005.
    expect(TENANT_SCOPED_TABLES.has('webhooks')).toBe(false);
  });
});

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, findAgentByExternal, setAgentExternalMapping, ExternalMappingError } from '../src/db/catalog';

/**
 * An agent maps onto a suite principal (charter decisions/2026-08-30-an-agent-is-a-principal.md
 * §5): the same `external_id` / `external_source` pair `tenants` already carries
 * (migrations/0002_tenant_external_mapping.sql), not a new shape.
 *
 * NULL stays the normal, complete state: a standalone kaambaan boots with no hub in existence,
 * and `kbn_` remains the native agent credential permanently — this mapping is an addition, not
 * a migration path.
 */
beforeAll(setupCatalog);

describe('an agent maps to a suite principal', () => {
  it('a freshly created agent carries no external mapping', async () => {
    const a = await createAgent(env.DB, 'tnt_a', { name: 'Solo', capabilities: [] });
    expect(a.externalId).toBeNull();
    expect(a.externalSource).toBeNull();
  });

  it('records a mapping and finds the local agent by it', async () => {
    const a = await createAgent(env.DB, 'tnt_a', { name: 'Forge', capabilities: ['research'] });
    await setAgentExternalMapping(env.DB, 'tnt_a', a.id, {
      externalId: 'prn_0123456789abcdef0123',
      externalSource: 'org-plane',
    });

    const found = await findAgentByExternal(env.DB, 'org-plane', 'prn_0123456789abcdef0123');
    expect(found?.agentId).toBe(a.id);
    expect(found?.tenantId).toBe('tnt_a');
    expect(found?.capabilities).toEqual(['research']);
  });

  it('an unmapped principal id finds nothing — absence, not a fault', async () => {
    expect(await findAgentByExternal(env.DB, 'org-plane', 'prn_nope')).toBeNull();
  });

  it('clears a mapping back to null', async () => {
    const a = await createAgent(env.DB, 'tnt_a', { name: 'Clearable', capabilities: [] });
    await setAgentExternalMapping(env.DB, 'tnt_a', a.id, { externalId: 'prn_clearme00000000000a', externalSource: 'org-plane' });
    expect((await findAgentByExternal(env.DB, 'org-plane', 'prn_clearme00000000000a'))?.agentId).toBe(a.id);

    await setAgentExternalMapping(env.DB, 'tnt_a', a.id, null);
    expect(await findAgentByExternal(env.DB, 'org-plane', 'prn_clearme00000000000a')).toBeNull();
  });

  it('rejects half a mapping — an id without the system it came from', async () => {
    const a = await createAgent(env.DB, 'tnt_a', { name: 'Half', capabilities: [] });
    await expect(
      setAgentExternalMapping(env.DB, 'tnt_a', a.id, { externalId: 'prn_x', externalSource: '' } as never),
    ).rejects.toThrow(ExternalMappingError);
    await expect(
      setAgentExternalMapping(env.DB, 'tnt_a', a.id, { externalSource: 'org-plane' } as never),
    ).rejects.toThrow(ExternalMappingError);
  });

  it('the database itself enforces both-or-neither (the CHECK, not just the guard)', async () => {
    await expect(
      env.DB.prepare(`INSERT INTO agents (id, tenant_id, name, external_id) VALUES (?, ?, ?, ?)`)
        .bind('agt_badpair', 'tnt_a', 'Bad pair', 'prn_onlyhalf00000000001')
        .run(),
    ).rejects.toThrow();
  });

  // --- Finding A: tenant-scoped WHERE, matching revokeAgentToken -----------------------------

  it('a mismatched tenant does not write the mapping — the WHERE clause matches revokeAgentToken', async () => {
    // `agents.id` is a bare primary key with no per-tenant uniqueness (the same fact that makes
    // `revokeAgentToken`'s `WHERE id = ? AND tenant_id = ? AND agent_id = ?` load-bearing).
    // Calling with the WRONG tenant must be a no-op, not a write that happens to land anyway
    // because the row still matched on `id` alone.
    const a = await createAgent(env.DB, 'tnt_a', { name: 'Guarded', capabilities: [] });
    await setAgentExternalMapping(env.DB, 'tnt_wrong', a.id, {
      externalId: 'prn_wrongtenant0000000a',
      externalSource: 'org-plane',
    });

    expect(await findAgentByExternal(env.DB, 'org-plane', 'prn_wrongtenant0000000a')).toBeNull();

    // And the RIGHT tenant still links it — proving the mismatch above genuinely changed
    // nothing, rather than the id having already been consumed by a partial write.
    await setAgentExternalMapping(env.DB, 'tnt_a', a.id, {
      externalId: 'prn_wrongtenant0000000a',
      externalSource: 'org-plane',
    });
    expect((await findAgentByExternal(env.DB, 'org-plane', 'prn_wrongtenant0000000a'))?.agentId).toBe(a.id);
  });

  // --- Finding B: one principal, one agent -----------------------------------------------------

  it('several unmapped agents coexist — NULL is not itself a collision under the partial index', async () => {
    const agents = await Promise.all(
      [1, 2, 3].map((n) => createAgent(env.DB, 'tnt_a', { name: `Unmapped ${n}`, capabilities: [] })),
    );
    for (const a of agents) {
      await expect(setAgentExternalMapping(env.DB, 'tnt_a', a.id, null)).resolves.toBeUndefined();
    }
  });

  it('the database itself enforces one agent per principal (migration 0004, not just the route check)', async () => {
    const first = await createAgent(env.DB, 'tnt_a', { name: 'Claimant One', capabilities: [] });
    const second = await createAgent(env.DB, 'tnt_a', { name: 'Claimant Two', capabilities: [] });
    await setAgentExternalMapping(env.DB, 'tnt_a', first.id, {
      externalId: 'prn_dupeclaim000000000a',
      externalSource: 'org-plane',
    });

    await expect(
      setAgentExternalMapping(env.DB, 'tnt_a', second.id, {
        externalId: 'prn_dupeclaim000000000a',
        externalSource: 'org-plane',
      }),
    ).rejects.toThrow();

    // The first claim is unharmed by the second's failed attempt.
    expect((await findAgentByExternal(env.DB, 'org-plane', 'prn_dupeclaim000000000a'))?.agentId).toBe(first.id);
  });
});

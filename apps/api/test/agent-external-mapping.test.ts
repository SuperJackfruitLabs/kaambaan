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
    await setAgentExternalMapping(env.DB, a.id, {
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
    await setAgentExternalMapping(env.DB, a.id, { externalId: 'prn_clearme00000000000a', externalSource: 'org-plane' });
    expect((await findAgentByExternal(env.DB, 'org-plane', 'prn_clearme00000000000a'))?.agentId).toBe(a.id);

    await setAgentExternalMapping(env.DB, a.id, null);
    expect(await findAgentByExternal(env.DB, 'org-plane', 'prn_clearme00000000000a')).toBeNull();
  });

  it('rejects half a mapping — an id without the system it came from', async () => {
    const a = await createAgent(env.DB, 'tnt_a', { name: 'Half', capabilities: [] });
    await expect(
      setAgentExternalMapping(env.DB, a.id, { externalId: 'prn_x', externalSource: '' } as never),
    ).rejects.toThrow(ExternalMappingError);
    await expect(
      setAgentExternalMapping(env.DB, a.id, { externalSource: 'org-plane' } as never),
    ).rejects.toThrow(ExternalMappingError);
  });

  it('the database itself enforces both-or-neither (the CHECK, not just the guard)', async () => {
    await expect(
      env.DB.prepare(`INSERT INTO agents (id, tenant_id, name, external_id) VALUES (?, ?, ?, ?)`)
        .bind('agt_badpair', 'tnt_a', 'Bad pair', 'prn_onlyhalf00000000001')
        .run(),
    ).rejects.toThrow();
  });
});

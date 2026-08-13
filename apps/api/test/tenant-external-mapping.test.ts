import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import {
  upsertUserByEmail,
  ensurePersonalWorkspace,
  primaryTenant,
  setTenantExternalMapping,
  ExternalMappingError,
  recordBoard,
  listBoards,
} from '../src/db/catalog';

beforeAll(setupCatalog);

async function freshTenant(email: string, name: string) {
  const u = await upsertUserByEmail(env.DB, { email, name });
  return ensurePersonalWorkspace(env.DB, u.id, name);
}

/**
 * kaambaan's tenant is a LOCAL isolation boundary, not an authority. `external_id` +
 * `external_source` record that the same real organisation is also known somewhere else
 * (`agentpod` today, the Organization plane later). The mapping is optional — a standalone
 * kaambaan has none — but it is never half-recorded: an id without the system it came from is
 * worse than no id at all, because nothing downstream can tell whose id space it belongs to.
 */
describe('tenant external mapping', () => {
  it('a standalone tenant has no external mapping, and that is a complete tenant', async () => {
    const t = await freshTenant('solo@x.com', 'Solo');
    expect(t.externalId).toBeNull();
    expect(t.externalSource).toBeNull();

    const read = await primaryTenant(env.DB, (await upsertUserByEmail(env.DB, { email: 'solo@x.com' })).id);
    expect(read?.id).toBe(t.id);
    expect(read?.externalId).toBeNull();
    expect(read?.externalSource).toBeNull();
  });

  it('the storage layer accepts a tenant row carrying neither half', async () => {
    await expect(
      env.DB.prepare(`INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)`)
        .bind('tnt_standalone', 'standalone', 'Standalone')
        .run(),
    ).resolves.toBeDefined();
  });

  it('records both halves together and reads them back', async () => {
    const t = await freshTenant('mapped@x.com', 'Mapped');
    await setTenantExternalMapping(env.DB, t.id, {
      externalId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      externalSource: 'agentpod',
    });

    const read = await primaryTenant(env.DB, (await upsertUserByEmail(env.DB, { email: 'mapped@x.com' })).id);
    expect(read?.externalId).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(read?.externalSource).toBe('agentpod');
  });

  it('clearing the mapping removes both halves together', async () => {
    const t = await freshTenant('unmap@x.com', 'Unmap');
    await setTenantExternalMapping(env.DB, t.id, { externalId: 'org_1', externalSource: 'org-plane' });
    await setTenantExternalMapping(env.DB, t.id, null);

    const read = await primaryTenant(env.DB, (await upsertUserByEmail(env.DB, { email: 'unmap@x.com' })).id);
    expect(read?.externalId).toBeNull();
    expect(read?.externalSource).toBeNull();
  });

  it('refuses an external id with no source naming whose id it is', async () => {
    const t = await freshTenant('halfid@x.com', 'HalfId');
    await expect(
      setTenantExternalMapping(env.DB, t.id, { externalId: 'org_1', externalSource: '' }),
    ).rejects.toBeInstanceOf(ExternalMappingError);
    await expect(
      setTenantExternalMapping(env.DB, t.id, { externalId: 'org_1' } as never),
    ).rejects.toBeInstanceOf(ExternalMappingError);
  });

  it('refuses a source with no external id', async () => {
    const t = await freshTenant('halfsrc@x.com', 'HalfSrc');
    await expect(
      setTenantExternalMapping(env.DB, t.id, { externalId: '', externalSource: 'agentpod' }),
    ).rejects.toBeInstanceOf(ExternalMappingError);
    await expect(
      setTenantExternalMapping(env.DB, t.id, { externalSource: 'agentpod' } as never),
    ).rejects.toBeInstanceOf(ExternalMappingError);
  });

  // The helper above is convenience; the database is the enforcement. These assert the CHECK
  // itself, so removing it fails a test even if the TypeScript guard is left intact.
  it('the database refuses an INSERT carrying only an external id', async () => {
    await expect(
      env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_id) VALUES (?, ?, ?, ?)`)
        .bind('tnt_rawid', 'rawid', 'RawId', 'org_1')
        .run(),
    ).rejects.toThrow();
  });

  it('the database refuses an INSERT carrying only an external source', async () => {
    await expect(
      env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_source) VALUES (?, ?, ?, ?)`)
        .bind('tnt_rawsrc', 'rawsrc', 'RawSrc', 'agentpod')
        .run(),
    ).rejects.toThrow();
  });

  it('the database refuses an UPDATE that strands one half on an existing tenant', async () => {
    const t = await freshTenant('strand@x.com', 'Strand');
    await expect(
      env.DB.prepare(`UPDATE tenants SET external_id = ? WHERE id = ?`).bind('org_1', t.id).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(`UPDATE tenants SET external_source = ? WHERE id = ?`).bind('agentpod', t.id).run(),
    ).rejects.toThrow();
  });

  it('the database accepts both halves together', async () => {
    await expect(
      env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_id, external_source) VALUES (?, ?, ?, ?, ?)`)
        .bind('tnt_rawboth', 'rawboth', 'RawBoth', 'org_1', 'agentpod')
        .run(),
    ).resolves.toBeDefined();
  });

  /**
   * Deliberately NOT unique: kaambaan is one-tenant-per-user, so two people in the same real
   * organisation legitimately map two local boundaries onto one external id. Isolation is local
   * and stays local — a shared mapping must not become a shared keyspace.
   */
  it('two tenants may map to the same external organisation and remain fully isolated', async () => {
    const a = await freshTenant('twin-a@x.com', 'TwinA');
    const b = await freshTenant('twin-b@x.com', 'TwinB');
    const mapping = { externalId: 'org_shared', externalSource: 'agentpod' };
    await setTenantExternalMapping(env.DB, a.id, mapping);
    await setTenantExternalMapping(env.DB, b.id, mapping);

    await recordBoard(env.DB, a.id, { id: 'brd_twina', name: 'A board', stagesJson: '[]' });
    expect((await listBoards(env.DB, a.id)).map((x) => x.id)).toContain('brd_twina');
    expect((await listBoards(env.DB, b.id)).map((x) => x.id)).not.toContain('brd_twina');
  });
});

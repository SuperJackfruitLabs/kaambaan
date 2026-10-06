import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { ensureOrgTenant, provisionOrgHuman } from '../src/auth/org-tenancy';
import { findTenantByExternal, findUserByExternal, setUserExternalMapping, upsertUserByEmail } from '../src/db/catalog';
import { roleFor } from '../src/db/members';

beforeAll(setupCatalog);

const org = (n: number) => `org_${n.toString(16).padStart(20, '0')}`;
const prn = (n: number) => `prn_${n.toString(16).padStart(20, '0')}`;

describe('ensureOrgTenant — first sight', () => {
  it('creates one tenant mapped to the org, and returns it again on the next sight', async () => {
    const a = await ensureOrgTenant(env.DB, org(0x101));
    const b = await ensureOrgTenant(env.DB, org(0x101));
    expect(a).toMatch(/^tnt_/);
    expect(b).toBe(a);
    expect(await findTenantByExternal(env.DB, 'org-plane', org(0x101))).toBe(a);
  });

  it('creates exactly ONE tenant when a board view fires many first requests at once', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => ensureOrgTenant(env.DB, org(0x102))));
    expect(new Set(ids).size).toBe(1);
    const { results } = await env.DB.prepare(`SELECT id FROM tenants WHERE external_source = 'org-plane' AND external_id = ?`)
      .bind(org(0x102)).all();
    expect(results).toHaveLength(1);
  });

  it('never reuses an agentpod-mapped tenant whose fleet id happens to equal nothing here', async () => {
    await env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_source, external_id) VALUES ('tnt_fleetonly', 'fleetonly', 'F', 'agentpod', 'fleet_0123456789abcdef0123')`).run();
    const t = await ensureOrgTenant(env.DB, org(0x103));
    expect(t).not.toBe('tnt_fleetonly');
  });
});

describe('provisionOrgHuman', () => {
  it('creates and maps a new person, who becomes owner of an empty org tenant', async () => {
    const t = await ensureOrgTenant(env.DB, org(0x201));
    const h = await provisionOrgHuman(env.DB, t, { sub: prn(0x201), email: 'First@Example.com', email_verified: true });
    expect(h?.role).toBe('owner');
    const mapped = await findUserByExternal(env.DB, 'org-plane', prn(0x201));
    expect(mapped?.id).toBe(h?.userId);
    expect(mapped?.email).toBe('first@example.com');
  });

  it('makes the second person a member, and never demotes or promotes an existing seat', async () => {
    const t = await ensureOrgTenant(env.DB, org(0x202));
    await provisionOrgHuman(env.DB, t, { sub: prn(0x202), email: 'a202@example.com', email_verified: true });
    const second = await provisionOrgHuman(env.DB, t, { sub: prn(0x203), email: 'b202@example.com', email_verified: true });
    expect(second?.role).toBe('member');
    await env.DB.prepare(`UPDATE memberships SET role = 'admin' WHERE tenant_id = ? AND user_id = ?`).bind(t, second!.userId).run();
    expect((await provisionOrgHuman(env.DB, t, { sub: prn(0x203) }))?.role).toBe('admin');
  });

  it('gives exactly one owner when two new people arrive at the same instant', async () => {
    const t = await ensureOrgTenant(env.DB, org(0x204));
    const [x, y] = await Promise.all([
      provisionOrgHuman(env.DB, t, { sub: prn(0x204), email: 'x204@example.com', email_verified: true }),
      provisionOrgHuman(env.DB, t, { sub: prn(0x205), email: 'y204@example.com', email_verified: true }),
    ]);
    expect([x?.role, y?.role].sort()).toEqual(['member', 'owner']);
  });

  it('adopts an unmapped GitHub-created user by verified address, exactly once', async () => {
    const gh = await upsertUserByEmail(env.DB, { email: 'Adopt.Me@Example.com', name: 'Adopt' });
    const t = await ensureOrgTenant(env.DB, org(0x206));
    const h = await provisionOrgHuman(env.DB, t, { sub: prn(0x206), email: 'adopt.me@example.com', email_verified: true });
    expect(h?.userId).toBe(gh.id);
  });

  it('does NOT adopt when the address is unverified, and creates nothing', async () => {
    await upsertUserByEmail(env.DB, { email: 'unverified@example.com', name: null });
    const t = await ensureOrgTenant(env.DB, org(0x207));
    expect(await provisionOrgHuman(env.DB, t, { sub: prn(0x207), email: 'unverified@example.com', email_verified: false })).toBeNull();
    expect(await provisionOrgHuman(env.DB, t, { sub: prn(0x208), email: 'nobody-yet@example.com', email_verified: 'true' as unknown as boolean })).toBeNull();
    expect(await findUserByExternal(env.DB, 'org-plane', prn(0x207))).toBeNull();
  });

  it('refuses — never captures — an account still mapped to the hub (re-pointed only by the P4 script)', async () => {
    const hubUser = await upsertUserByEmail(env.DB, { email: 'hub-linked@example.com', name: null });
    await setUserExternalMapping(env.DB, hubUser.id, { externalSource: 'agentpod', externalId: 'BetterAuthId123' });
    const t = await ensureOrgTenant(env.DB, org(0x209));
    expect(await provisionOrgHuman(env.DB, t, { sub: prn(0x209), email: 'hub-linked@example.com', email_verified: true })).toBeNull();
    expect(await roleFor(env.DB, t, hubUser.id)).toBeNull();
  });

  it('resolves an already-mapped person by sub alone, with no email claim at all', async () => {
    const t = await ensureOrgTenant(env.DB, org(0x20a));
    const first = await provisionOrgHuman(env.DB, t, { sub: prn(0x20a), email: 'sub-only@example.com', email_verified: true });
    expect((await provisionOrgHuman(env.DB, t, { sub: prn(0x20a) }))?.userId).toBe(first?.userId);
  });

  it('survives two concurrent first sign-ins of the SAME person: one user, one mapping, no 500', async () => {
    const t = await ensureOrgTenant(env.DB, org(0x20b));
    const claims = { sub: prn(0x20b), email: 'twice@example.com', email_verified: true };
    const [a, b] = await Promise.all([provisionOrgHuman(env.DB, t, claims), provisionOrgHuman(env.DB, t, claims)]);
    expect(a?.userId).toBeTruthy();
    expect(b?.userId).toBe(a?.userId);
    const { results } = await env.DB.prepare(`SELECT id FROM users WHERE external_source = 'org-plane' AND external_id = ?`).bind(prn(0x20b)).all();
    expect(results).toHaveLength(1);
  });
});

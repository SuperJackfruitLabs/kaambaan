import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { planRepoint, type CatalogSnapshot, type RepointMapping } from '../src/db/repoint-org-plane';

beforeAll(setupCatalog);

const FLEET_A = 'fleet_000000000000000000aa';
const FLEET_B = 'fleet_000000000000000000bb';
const ORG_A = 'org_000000000000000000aa';
const ORG_B = 'org_000000000000000000bb';
const PRN_1 = 'prn_00000000000000000001';
const PRN_2 = 'prn_00000000000000000002';

async function seed() {
  await env.DB.exec(`DELETE FROM memberships; DELETE FROM users; DELETE FROM tenants;`);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_source, external_id) VALUES ('tnt_a', 'a', 'A', 'agentpod', ?)`).bind(FLEET_A),
    env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_source, external_id) VALUES ('tnt_b1', 'b1', 'B1', 'agentpod', ?)`).bind(FLEET_B),
    env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_source, external_id) VALUES ('tnt_b2', 'b2', 'B2', 'agentpod', ?)`).bind(FLEET_B),
    env.DB.prepare(`INSERT INTO tenants (id, slug, name) VALUES ('tnt_solo', 'solo', 'Solo')`),
    env.DB.prepare(`INSERT INTO users (id, email, external_source, external_id) VALUES ('usr_1', 'one@example.com', 'agentpod', 'BetterAuthOne')`),
    env.DB.prepare(`INSERT INTO users (id, email, external_source, external_id) VALUES ('usr_2', 'two@example.com', 'agentpod', 'BetterAuthTwo')`),
    env.DB.prepare(`INSERT INTO users (id, email) VALUES ('usr_gh', 'gh@example.com')`),
  ]);
}

async function snapshot(): Promise<CatalogSnapshot> {
  const t = await env.DB.prepare(`SELECT id, external_source, external_id FROM tenants ORDER BY id`).all();
  const u = await env.DB.prepare(`SELECT id, external_source, external_id FROM users ORDER BY id`).all();
  return { tenants: t.results as CatalogSnapshot['tenants'], users: u.results as CatalogSnapshot['users'] };
}

async function apply(statements: string[]) {
  for (const s of statements) await env.DB.prepare(s).run();
}

const MAPPING: RepointMapping = {
  tenants: { [FLEET_A]: ORG_A, [FLEET_B]: ORG_B },
  chosenTenants: { [ORG_B]: 'tnt_b2' },
  users: { BetterAuthOne: PRN_1, BetterAuthTwo: PRN_2 },
};

beforeEach(seed);

describe('planRepoint', () => {
  it('re-points mapped tenants and users, and touches nothing else', async () => {
    const plan = planRepoint(await snapshot(), MAPPING, 'forward');
    expect(plan.conflicts).toEqual([]);
    expect(plan.tenants).toEqual([
      { id: 'tnt_a', from: `agentpod:${FLEET_A}`, to: `org-plane:${ORG_A}` },
      { id: 'tnt_b2', from: `agentpod:${FLEET_B}`, to: `org-plane:${ORG_B}` },
    ]);
    expect(plan.unmapped.tenants).toEqual(['tnt_b1']);
    await apply(plan.statements);
    const after = await snapshot();
    expect(after.tenants.find((t) => t.id === 'tnt_b1')).toMatchObject({ external_source: 'agentpod', external_id: FLEET_B });
    expect(after.tenants.find((t) => t.id === 'tnt_solo')).toMatchObject({ external_source: null });
    expect(after.users.find((u) => u.id === 'usr_1')).toMatchObject({ external_source: 'org-plane', external_id: PRN_1 });
    expect(after.users.find((u) => u.id === 'usr_gh')).toMatchObject({ external_source: null });
  });

  it('is idempotent: a second plan after applying is empty', async () => {
    await apply(planRepoint(await snapshot(), MAPPING, 'forward').statements);
    expect(planRepoint(await snapshot(), MAPPING, 'forward').statements).toEqual([]);
  });

  it('round-trips: reverse restores the hub mappings exactly', async () => {
    const before = await snapshot();
    await apply(planRepoint(before, MAPPING, 'forward').statements);
    await apply(planRepoint(await snapshot(), MAPPING, 'reverse').statements);
    expect(await snapshot()).toEqual(before);
  });

  it('reports a shared fleet with no chosen tenant as a conflict and writes nothing for it', async () => {
    const plan = planRepoint(await snapshot(), { ...MAPPING, chosenTenants: {} }, 'forward');
    expect(plan.conflicts).toEqual([`${FLEET_B} is linked by 2 tenants (tnt_b1, tnt_b2); name one in chosenTenants["${ORG_B}"]`]);
    expect(plan.statements.join('\n')).not.toContain(ORG_B);
  });

  it('reports a target already held by another row as a conflict', async () => {
    await env.DB.prepare(`INSERT INTO users (id, email, external_source, external_id) VALUES ('usr_new', 'new@example.com', 'org-plane', ?)`).bind(PRN_1).run();
    const plan = planRepoint(await snapshot(), MAPPING, 'forward');
    expect(plan.conflicts).toContain(`${PRN_1} is already held by usr_new`);
  });

  it('refuses malformed mapping ids instead of writing them', () => {
    expect(() => planRepoint({ tenants: [], users: [] }, { tenants: { [FLEET_A]: 'org_SHOUTING' }, users: {} }, 'forward')).toThrow(/org_/);
    expect(() => planRepoint({ tenants: [], users: [] }, { tenants: {}, users: { x: 'usr_not_a_principal' } }, 'forward')).toThrow(/prn_/);
  });

  it('guards every UPDATE on the old value, so a row changed since the snapshot is left alone', () => {
    const plan = planRepoint({ tenants: [{ id: 'tnt_a', external_source: 'agentpod', external_id: FLEET_A }], users: [] }, MAPPING, 'forward');
    expect(plan.statements[0]).toBe(
      `UPDATE tenants SET external_source = 'org-plane', external_id = '${ORG_A}', updated_at = datetime('now') WHERE id = 'tnt_a' AND external_source = 'agentpod' AND external_id = '${FLEET_A}';`,
    );
  });

  it.each(['forward', 'reverse'] as const)('refuses (%s) two fleets mapped to one org, and two hub ids mapped to one prn_', async (direction) => {
    const doubled: RepointMapping = {
      tenants: { [FLEET_A]: ORG_A, [FLEET_B]: ORG_A },
      chosenTenants: { [ORG_B]: 'tnt_b2' },
      users: { BetterAuthOne: PRN_1, BetterAuthTwo: PRN_1 },
    };
    const plan = planRepoint(await snapshot(), doubled, direction);
    expect(plan.conflicts).toContain(`${ORG_A} is the target of more than one fleet (${FLEET_A}, ${FLEET_B})`);
    expect(plan.conflicts).toContain(`${PRN_1} is the target of more than one hub user (BetterAuthOne, BetterAuthTwo)`);
    expect(plan.statements.join('\n')).not.toContain(ORG_A);
    expect(plan.statements.join('\n')).not.toContain(PRN_1);
  });
});

/**
 * superpipeline ids → suite principal ids, for evidence (contract C4). Only mapped, prn_-shaped
 * values come back; everything else is absent from the map, which the route reads as null.
 */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import {
  createAgent, hubSubjectsFor, principalIdsFor, setAgentExternalMapping, setUserExternalMapping, upsertUserByEmail,
} from '../src/db/catalog';

const TENANT = 'tnt_principal_ids';
const OTHER_TENANT = 'tnt_principal_ids_other';
const AGENT_PRN = 'prn_0123456789abcdef0a01';
const USER_PRN = 'prn_0123456789abcdef0b01';

beforeAll(async () => {
  await setupCatalog();
  for (const t of [TENANT, OTHER_TENANT]) {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'P')`).bind(t, `slug-${t}`).run();
  }
});

describe('principalIdsFor', () => {
  it('maps a linked agent, a prn-linked user and a bare prn; leaves the rest out', async () => {
    const linked = await createAgent(env.DB, TENANT, { name: 'linked' });
    await setAgentExternalMapping(env.DB, TENANT, linked.id, { externalId: AGENT_PRN, externalSource: 'org-plane' });
    const unlinked = await createAgent(env.DB, TENANT, { name: 'unlinked' });
    const human = await upsertUserByEmail(env.DB, { email: 'ids-human@example.com' });
    await setUserExternalMapping(env.DB, human.id, { externalId: USER_PRN, externalSource: 'agentpod' });
    const betterAuth = await upsertUserByEmail(env.DB, { email: 'ids-ba@example.com' });
    await setUserExternalMapping(env.DB, betterAuth.id, { externalId: '68jYD9VOCmXlPhIY', externalSource: 'agentpod' });

    const ids = await principalIdsFor(env.DB, TENANT, [
      linked.id, unlinked.id, human.id, betterAuth.id, 'prn_ffffffffffffffffffff', 'usr_nobody', null, '',
    ]);
    expect(Object.fromEntries(ids)).toEqual({
      [linked.id]: AGENT_PRN,
      [human.id]: USER_PRN,
      prn_ffffffffffffffffffff: 'prn_ffffffffffffffffffff',
    });
  });

  it('an agent mapped in another tenant does not resolve here', async () => {
    const other = await createAgent(env.DB, OTHER_TENANT, { name: 'elsewhere' });
    await setAgentExternalMapping(env.DB, OTHER_TENANT, other.id, { externalId: 'prn_0123456789abcdef0c01', externalSource: 'org-plane' });
    expect((await principalIdsFor(env.DB, TENANT, [other.id])).size).toBe(0);
  });

  it('an empty list asks nothing', async () => {
    expect((await principalIdsFor(env.DB, TENANT, [])).size).toBe(0);
  });
});

describe('hubSubjectsFor', () => {
  it("returns a linked user's non-prn hub sub, and a raw sub as itself; never a prn, an agent or an unlinked usr_", async () => {
    const baUser = await upsertUserByEmail(env.DB, { email: 'sub-ba@example.com' });
    // A different id from the principalIdsFor test: D1 rows persist across tests in this file, and
    // users(external_source, external_id) is unique.
    await setUserExternalMapping(env.DB, baUser.id, { externalId: '68jYD9VOCmXlPhIZ', externalSource: 'agentpod' });
    const prnUser = await upsertUserByEmail(env.DB, { email: 'sub-prn@example.com' });
    await setUserExternalMapping(env.DB, prnUser.id, { externalId: 'prn_0123456789abcdef0d01', externalSource: 'agentpod' });
    const plain = await upsertUserByEmail(env.DB, { email: 'sub-plain@example.com' });

    const subs = await hubSubjectsFor(env.DB, [
      baUser.id, prnUser.id, plain.id, 'agt_whoever', 'prn_ffffffffffffffffffff', 'rawSubFromHub1', null, '',
    ]);
    expect(Object.fromEntries(subs)).toEqual({ [baUser.id]: '68jYD9VOCmXlPhIZ', rawSubFromHub1: 'rawSubFromHub1' });
  });
});

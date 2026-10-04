/**
 * A hub caller who has linked their principal to a local user resolves as THAT USER.
 *
 * `resolveHubUser` used to look up a membership by `claims.sub` — a hub principal id — but
 * memberships are only ever written with superpipeline's own `usr_` ids, so that lookup could never
 * hit and every hub caller fell back to `member` under the foreign id. The same human is `owner`
 * in the browser and `member` at a terminal, and `POST /v1/boards` refuses the second.
 *
 * `findUserByExternal` (task 3) is the fix: read the mapping first, and if it says someone has
 * linked this principal, resolve as that person — their real role, and their local `usr_` id on
 * anything recorded on their behalf. No mapping still falls back to `member`, unchanged.
 */
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resolveHubUser } from '../src/auth/resolve';
import { addMember } from '../src/db/members';
import { setTenantExternalMapping, setUserExternalMapping } from '../src/db/catalog';
import { withIssuer } from './helpers/hub-issuer';

const ISSUER = 'https://issuer.test';

/**
 * The origin this Worker answers on in these tests, and therefore the audience a hub token
 * must name (`auth/hub-jwt.ts`, `planeAudience`). Before 2026-09-20 the check asked for the
 * issuer, which every token carries, so `aud` was decoration here.
 */
const PLANE = 'https://api.test';
const FLEET = 'fleet_00000000000000hprtst';
const TENANT = 'tnt_hub_principal_role';

/**
 * ONE issuer for the whole file, minted once (mirrors `tenant-link-rest.test.ts`).
 *
 * `hub-jwt.ts` caches a JWKS per issuer for ten minutes and refetches only on an UNKNOWN kid, so
 * a fresh key pair per test under a reused kid verifies against the first test's cached key and
 * fails — a property of the cache working correctly, not a bug, but a trap worth naming here.
 */
let issuerOnce: Promise<{ signingKey: CryptoKey; jwksBody: string }> | null = null;
function newIssuer() {
  issuerOnce ??= (async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    const jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'hpr-kid' }] });
    return { signingKey: pair.privateKey, jwksBody };
  })();
  return issuerOnce;
}

async function hubToken(signingKey: CryptoKey, sub: string, fleet: string = FLEET): Promise<string> {
  return new SignJWT({ sub, principalKind: 'human', tenant: fleet })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'hpr-kid' })
    .setIssuer(ISSUER)
    .setAudience([ISSUER, PLANE])
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}

function req(token: string): Request {
  return new Request('https://api.test/v1/boards', { headers: { Authorization: `Bearer ${token}` } });
}

describe('resolveHubUser reads the linked-principal mapping', () => {
  it('a linked principal reads its real role and its local id', async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'HPR')`)
      .bind(TENANT, `slug-${TENANT}`).run();
    await setTenantExternalMapping(env.DB, TENANT, { externalId: FLEET, externalSource: 'agentpod' });

    // user is owner of the tenant; principal prn_1 is mapped to them
    const user = await addMember(env.DB, TENANT, { email: 'linked-owner@example.com', role: 'owner' });
    await setUserExternalMapping(env.DB, user.userId, { externalId: 'prn_1', externalSource: 'agentpod' });

    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(ISSUER, jwksBody, async () => {
      const p = await resolveHubUser(req(await hubToken(signingKey, 'prn_1')), env);
      expect(p?.role).toBe('owner');
      expect(p?.userId, 'the local usr_ id, not the principal id').toBe(user.userId);
      expect(p?.userId).not.toBe('prn_1');
    });
  });

  it('an unlinked principal still falls back to member', async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'HPR')`)
      .bind(TENANT, `slug-${TENANT}`).run();
    await setTenantExternalMapping(env.DB, TENANT, { externalId: FLEET, externalSource: 'agentpod' });

    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(ISSUER, jwksBody, async () => {
      const p = await resolveHubUser(req(await hubToken(signingKey, 'prn_unknown')), env);
      expect(p?.role).toBe('member');
      expect(p?.userId).toBe('prn_unknown');
    });
  });

  it('a linked principal who is not a member of THIS tenant is a member, not an owner', async () => {
    // A distinct fleet id from `TENANT`'s — `findTenantByExternal` resolves a many-to-one mapping
    // with an unordered `.first()` (documented, deliberate ambiguity — see
    // `tenant-link-rest.test.ts`), so sharing `FLEET` here would make which tenant resolves
    // nondeterministic rather than testing the role rule this test is actually about.
    const OTHER = 'tnt_hub_principal_role_other';
    const OTHER_FLEET = 'fleet_00000000000hprtst2';
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'HPR2')`)
      .bind(OTHER, `slug-${OTHER}`).run();
    await setTenantExternalMapping(env.DB, OTHER, { externalId: OTHER_FLEET, externalSource: 'agentpod' });

    // Linked, but only elsewhere — not a member of `OTHER` at all.
    const user = await addMember(env.DB, TENANT, { email: 'linked-elsewhere@example.com', role: 'owner' });
    await setUserExternalMapping(env.DB, user.userId, { externalId: 'prn_2', externalSource: 'agentpod' });

    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(ISSUER, jwksBody, async () => {
      const p = await resolveHubUser(req(await hubToken(signingKey, 'prn_2', OTHER_FLEET)), env);
      expect(p?.tenantId).toBe(OTHER);
      expect(p?.role, 'linked, but not a member here — member, not owner').toBe('member');
      expect(p?.userId).toBe(user.userId);
    });
  });
});

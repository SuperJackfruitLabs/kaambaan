/**
 * Reading the capability registry with a hub token.
 *
 * Routing is exact string equality between a stage's `owner` and an agent's EFFECTIVE capability
 * set. So when a card will not move, the whole diagnosis is that comparison — and until this, the
 * two sides of it were readable from opposite ends of the estate: `GET /v1/agents` admitted a hub
 * token (`index.ts`: `if (!u && request.method === 'GET') u = await resolveHubUser(...)`), while
 * `GET /v1/capabilities` and `GET /v1/capabilities/implications` used `resolveUser` alone and so
 * answered 401 to every terminal. A lane whose capability nobody holds is a real state rather than
 * an error, which is exactly why it must be visible without opening a browser.
 *
 * Reads only. The route's own comment says a read is for "anyone who can see the board", while
 * defining the vocabulary "is the same class of act as managing its agents" — and managing agents
 * is deliberately session-only. That boundary is unchanged here.
 */
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { addMember } from '../src/db/members';
import { setTenantExternalMapping, setUserExternalMapping } from '../src/db/catalog';
import { withIssuer } from './helpers/hub-issuer';

const ISSUER = 'https://issuer.test';
/** The audience a hub token must name — this Worker's own origin (`auth/hub-jwt.ts`). */
const PLANE = 'https://api.test';
const FLEET = 'fleet_0000000000000caphub';
const TENANT = 'tnt_caps_hub_read';
const KID = 'caps-hub-kid';

/** One issuer per file: the JWKS is cached per issuer and refetched only on an unknown kid. */
let issuerOnce: Promise<{ signingKey: CryptoKey; jwksBody: string }> | null = null;
function newIssuer() {
  issuerOnce ??= (async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    const jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: KID }] });
    return { signingKey: pair.privateKey, jwksBody };
  })();
  return issuerOnce;
}

async function hubToken(signingKey: CryptoKey, sub: string): Promise<string> {
  return new SignJWT({ sub, principalKind: 'human', tenant: FLEET })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID })
    .setIssuer(ISSUER)
    .setAudience([ISSUER, PLANE])
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}

async function linkedOwner(): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'CapsHub')`)
    .bind(TENANT, `slug-${TENANT}`)
    .run();
  await setTenantExternalMapping(env.DB, TENANT, { externalId: FLEET, externalSource: 'agentpod' });
  const user = await addMember(env.DB, TENANT, { email: 'caps-hub-owner@example.com', role: 'owner' });
  await setUserExternalMapping(env.DB, user.userId, { externalId: 'prn_caps_hub', externalSource: 'agentpod' });
}

describe('a hub token may read the capability registry', () => {
  it('GET /v1/capabilities answers a hub token', async () => {
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_caps_hub');
      const res = await SELF.fetch('https://api.test/v1/capabilities', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status, 'a terminal must be able to read what the lanes ask for').toBe(200);
      const body = await res.json<{ capabilities: unknown[] }>();
      expect(Array.isArray(body.capabilities)).toBe(true);
    });
  });

  it('GET /v1/capabilities/implications answers a hub token', async () => {
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_caps_hub');
      const res = await SELF.fetch('https://api.test/v1/capabilities/implications', {
        headers: { Authorization: `Bearer ${token}` },
      });
      // The edges are half the diagnosis: a declared set that reaches a lane only through an
      // implication looks like a mismatch until the edges are visible too.
      expect(res.status).toBe(200);
      const body = await res.json<{ implications: unknown[] }>();
      expect(Array.isArray(body.implications)).toBe(true);
    });
  });

  it('still refuses a hub token that tries to DEFINE a capability', async () => {
    // The boundary this change does NOT move. Defining the vocabulary is "the same class of act as
    // managing its agents", and managing agents is session-only on purpose.
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_caps_hub');
      const res = await SELF.fetch('https://api.test/v1/capabilities', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'claim-check', name: 'Claim check' }),
      });
      expect(res.status, 'a write must still require a session').toBe(401);
    });
  });
});

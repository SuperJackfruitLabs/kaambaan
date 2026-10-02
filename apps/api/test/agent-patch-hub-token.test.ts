import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { addMember } from '../src/db/members';
import { createAgent, setTenantExternalMapping, setUserExternalMapping } from '../src/db/catalog';

/**
 * Configuring an agent with a hub token.
 *
 * `supi` carries a hub token and nothing else. The agents routes admitted one for GET alone, so
 * the queueing policy shipped with a setter the only client written for it could not call — the
 * same "a permission whose setter nobody can reach" failure that setter existed to fix, one layer
 * along. It answered 401 while `supi agents` beside it answered 200.
 *
 * The restriction's own reason was narrow and is preserved exactly: "a first integration should not
 * also be the first credential able to mint an agent token." That is about CREDENTIALS. So:
 *
 *   PATCH  — admitted. It changes what an agent is, and mints nothing.
 *   POST   — refused. It mints a credential (charter Decision 3: an agent must never mint itself a
 *            second credential to outlive one a person revoked).
 *   DELETE — refused. It revokes one.
 *   PATCH carrying `externalId` — refused. Mapping an agent to a principal is what makes a hub
 *            agent token resolve at all, so a hub token must not be able to establish it.
 */
const ISSUER = 'https://issuer.test';
const PLANE = 'https://api.test';
const FLEET = 'fleet_0000000000agentpatch';
const TENANT = 'tnt_agent_patch_hub';
const KID = 'agent-patch-kid';

let issuerOnce: Promise<{ signingKey: CryptoKey; jwksBody: string }> | null = null;
function newIssuer() {
  issuerOnce ??= (async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    const jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: KID }] });
    return { signingKey: pair.privateKey, jwksBody };
  })();
  return issuerOnce;
}

async function withIssuer(jwksBody: string, fn: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  (env as unknown as Record<string, unknown>).HUB_ISSUER = ISSUER;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === `${ISSUER}/api/auth/jwks`) {
      return new Response(jwksBody, { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
  }
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

let ownerPrincipal = 'prn_agent_patch_owner';
async function linkedOwner(): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'AgentPatch')`)
    .bind(TENANT, `slug-${TENANT}`)
    .run();
  await setTenantExternalMapping(env.DB, TENANT, { externalId: FLEET, externalSource: 'agentpod' });
  const user = await addMember(env.DB, TENANT, { email: 'agent-patch-owner@example.com', role: 'owner' });
  await setUserExternalMapping(env.DB, user.userId, { externalId: ownerPrincipal, externalSource: 'agentpod' });
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

describe('a hub token configures an agent, and still cannot touch its credentials', () => {
  it('PATCHes the queueing policy — the whole point, since supi carries nothing else', async () => {
    await linkedOwner();
    const agent = await createAgent(env.DB, TENANT, { name: 'Coordinator', capabilities: ['command'] });
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, ownerPrincipal);
      const res = await SELF.fetch(`${PLANE}/v1/agents/${agent.id}`, {
        method: 'PATCH',
        headers: auth(token),
        body: JSON.stringify({ queueCeilingPerHour: 7 }),
      });
      expect(res.status, 'a terminal must be able to bound what an agent queues').toBe(200);

      const list = await SELF.fetch(`${PLANE}/v1/agents`, { headers: auth(token) });
      const { agents } = await list.json<{ agents: Array<Record<string, unknown>> }>();
      expect(agents.find((a) => a.id === agent.id)?.queueCeilingPerHour).toBe(7);
    });
  });

  it('may also restaff it, because that is configuration rather than a credential', async () => {
    await linkedOwner();
    const agent = await createAgent(env.DB, TENANT, { name: 'Restaffable', capabilities: ['research'] });
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, ownerPrincipal);
      const res = await SELF.fetch(`${PLANE}/v1/agents/${agent.id}`, {
        method: 'PATCH',
        headers: auth(token),
        body: JSON.stringify({ capabilities: ['research', 'code'] }),
      });
      expect(res.status).toBe(200);
    });
  });

  it('CANNOT mint a token — the reason the restriction existed, unchanged', async () => {
    await linkedOwner();
    const agent = await createAgent(env.DB, TENANT, { name: 'No new creds', capabilities: ['command'] });
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, ownerPrincipal);
      const res = await SELF.fetch(`${PLANE}/v1/agents/${agent.id}/tokens`, {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({}),
      });
      expect(res.status, 'minting a credential stays session-only').toBe(401);
    });
  });

  it('CANNOT delete an agent', async () => {
    await linkedOwner();
    const agent = await createAgent(env.DB, TENANT, { name: 'Undeletable', capabilities: ['command'] });
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, ownerPrincipal);
      const res = await SELF.fetch(`${PLANE}/v1/agents/${agent.id}`, { method: 'DELETE', headers: auth(token) });
      expect(res.status).toBe(401);
    });
  });

  it('CANNOT map an agent to a principal, which is what makes an agent token resolve', async () => {
    // The escalation this closes: a hub token that could write `external_id` could point an agent
    // row at any principal, and `resolveHubAgent` resolves an agent-kind token BY that mapping. A
    // credential able to establish the mapping that makes credentials resolve is a credential that
    // grants itself identities.
    await linkedOwner();
    const agent = await createAgent(env.DB, TENANT, { name: 'Unmappable', capabilities: ['command'] });
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, ownerPrincipal);
      const res = await SELF.fetch(`${PLANE}/v1/agents/${agent.id}`, {
        method: 'PATCH',
        headers: auth(token),
        // A well-formed principal id, so the refusal under test is the credential check and not
        // the shape check that sits beside it.
        body: JSON.stringify({ externalId: 'prn_00000000000000000aaa' }),
      });
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toMatch(/externalId/);
    });
  });

  it('a SESSION may still do all of it, so nothing is taken away from a person', async () => {
    const agent = await createAgent(env.DB, 'tnt_agent_patch_dev', { name: 'Session-driven', capabilities: ['command'] });
    const res = await SELF.fetch(`${PLANE}/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'X-Tenant-Id': 'tnt_agent_patch_dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalId: 'prn_00000000000000000bbb' }),
    });
    expect(res.status).toBe(200);
  });
});

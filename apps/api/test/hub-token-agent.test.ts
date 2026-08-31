/**
 * Resolving an AGENT-kind hub token to a local agent principal.
 *
 * `charter → decisions/2026-08-30-an-agent-is-a-principal.md` gives a node the ability to
 * exchange its own credential for a short-lived hub token whose `sub` is a bare `prn_…`
 * principal id and whose `principalKind` is `"agent"`. kaambaan must accept it AS THAT AGENT —
 * exactly the way `resolveHubUser` already accepts a human-kind token, mirrored here rather
 * than reinvented.
 *
 * Two properties this file exists to protect, both named in the task brief:
 *
 *   - **Capabilities never come from the claim.** They are kaambaan's own vocabulary
 *     (`charter → decisions/2026-08-15-a-grant-names-an-agent-per-plane.md` calls putting them
 *     in a cross-plane claim "a trap — the same word, two vocabularies"). The token names a
 *     principal; kaambaan looks up its OWN `agents` row for capabilities, via
 *     `findAgentByExternal(db, 'org-plane', sub)`.
 *   - **A `kbn_` token keeps working, unchanged.** It is kaambaan's native agent credential and
 *     a standalone board — one with no hub in existence — depends on it entirely.
 */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { setupCatalog } from './helpers/catalog';
import { resolveHubAgent } from '../src/auth/resolve';
import { createAgent, setAgentExternalMapping } from '../src/db/catalog';

const ISSUER = 'https://issuer.test';
const FLEET = 'fleet_0000000000000000hbta';

let signingKey: CryptoKey;
let jwksBody: string;

beforeAll(async () => {
  await setupCatalog();
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'hta-kid' }] });
});

async function withIssuer(fn: () => Promise<void>): Promise<void> {
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

async function hubToken(over: Record<string, unknown>): Promise<string> {
  return new SignJWT({ tenant: FLEET, ...over })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'hta-kid' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime('5m')
    .sign(signingKey);
}

function req(token: string): Request {
  return new Request('https://api.test/v1/boards/brd_x/claims', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('resolving an agent-kind hub token', () => {
  it('resolves to the local agent its sub maps to, with the agent\'s OWN capabilities', async () => {
    const agent = await createAgent(env.DB, 'tnt_hta', { name: 'Researcher', capabilities: ['research', 'review'] });
    await setAgentExternalMapping(env.DB, agent.id, {
      externalId: 'prn_0000000000000000hbtaA',
      externalSource: 'org-plane',
    });

    await withIssuer(async () => {
      const token = await hubToken({ sub: 'prn_0000000000000000hbtaA', principalKind: 'agent' });
      const resolved = await resolveHubAgent(req(token), env);

      expect(resolved).not.toBeNull();
      expect(resolved!.agentId).toBe(agent.id);
      expect(resolved!.tenantId).toBe('tnt_hta');
      // The claim carries no capabilities at all — proving these came from the catalog row, not
      // the token, would require asserting a shape the JWT never had. What this DOES prove: the
      // resolved capabilities are exactly the local row's, not empty and not invented.
      expect(resolved!.capabilities).toEqual(['research', 'review']);
      expect(resolved!.externalId).toBe('prn_0000000000000000hbtaA');
    });
  });

  it('refuses a sub that maps to no local agent — not admitted with a null agent', async () => {
    await withIssuer(async () => {
      const token = await hubToken({ sub: 'prn_nobodyhome00000000000', principalKind: 'agent' });
      expect(await resolveHubAgent(req(token), env)).toBeNull();
    });
  });

  it('does not resolve a HUMAN-kind hub token as an agent', async () => {
    // Same sub, same mapped agent — the only thing different is principalKind. If this resolved,
    // any human's token would double as an agent credential.
    const agent = await createAgent(env.DB, 'tnt_hta', { name: 'Human-in-agent-clothes' });
    await setAgentExternalMapping(env.DB, agent.id, {
      externalId: 'prn_humansub000000000000',
      externalSource: 'org-plane',
    });

    await withIssuer(async () => {
      const token = await hubToken({ sub: 'prn_humansub000000000000', principalKind: 'human' });
      expect(await resolveHubAgent(req(token), env)).toBeNull();
    });
  });

  it('refuses an invalid token', async () => {
    await withIssuer(async () => {
      expect(await resolveHubAgent(req('not-a-jwt'), env)).toBeNull();
    });
  });

  it('leaves a kbn_ token untouched — it is not a JWT candidate for this path', async () => {
    await withIssuer(async () => {
      expect(await resolveHubAgent(req('kbn_something'), env)).toBeNull();
    });
  });

  it('without HUB_ISSUER configured, resolves nothing (no hub in existence)', async () => {
    const agent = await createAgent(env.DB, 'tnt_hta', { name: 'Standalone' });
    await setAgentExternalMapping(env.DB, agent.id, {
      externalId: 'prn_standalone000000000',
      externalSource: 'org-plane',
    });
    // No withIssuer() here — HUB_ISSUER is unset, as it is on a real standalone board.
    const token = await new SignJWT({ sub: 'prn_standalone000000000', principalKind: 'agent', tenant: FLEET })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'hta-kid' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setExpirationTime('5m')
      .sign(signingKey);

    expect(await resolveHubAgent(req(token), env)).toBeNull();
  });
});

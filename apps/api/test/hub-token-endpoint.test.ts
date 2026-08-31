import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

/**
 * `GET /v1/agents` accepting a hub-issued token — the first endpoint to do so
 * (charter decisions/2026-08-15-one-issuer-and-offline-verification.md).
 *
 * What these establish beyond the unit tests: the credential reaches the route,
 * resolves to the SAME principal a dev/session caller resolves to, and the
 * existing paths still take precedence. A verifier that works in isolation and
 * is not wired to anything is the failure mode this repo has met before — the
 * MCP surface advertising an authorization server it never served.
 */

const FLEET = 'fleet_00000000000000000099';
const TENANT = 'tnt_hubtoken';
let issuerOrigin: string;
let signingKey: CryptoKey;
let jwksBody: string;

/** Stand in for the hub: serve a JWKS the Worker can fetch, and sign like it. */
async function startIssuer(): Promise<string> {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  const pub = await exportJWK(pair.publicKey);
  jwksBody = JSON.stringify({ keys: [{ ...pub, alg: 'EdDSA', kid: 'itest-kid' }] });
  // Nothing listens on this origin. The two cases that need the Worker to reach
  // it stub `globalThis.fetch` for the duration — the test and the Worker share
  // an isolate here — and restore it afterwards. The other cases never get far
  // enough to fetch anything, because HUB_ISSUER is unset for them.
  return 'https://issuer.test';
}

async function hubToken(over: Record<string, unknown> = {}) {
  return new SignJWT({ sub: 'user_hub', principalKind: 'human', tenant: FLEET, ...over })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'itest-kid' })
    .setIssuedAt()
    .setIssuer(issuerOrigin)
    .setAudience(issuerOrigin)
    .setExpirationTime('5m')
    .sign(signingKey);
}

beforeAll(async () => {
  issuerOrigin = await startIssuer();

  // A board of our own, mapped to the hub's boundary. Without the mapping a
  // verified token still resolves to nothing — which is the intended refusal,
  // and is asserted separately below.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, 'hubtoken', 'Hub Token')`
  ).bind(TENANT).run();
  await env.DB.prepare(
    `UPDATE tenants SET external_source = 'agentpod', external_id = ? WHERE id = ?`
  ).bind(FLEET, TENANT).run();
});

describe('GET /v1/agents with a hub-issued token', () => {
  it('refuses when no issuer is configured, rather than trusting any issuer', async () => {
    // HUB_ISSUER now ships in wrangler.jsonc, so the test environment inherits
    // one — this case has to remove it rather than assume its absence. That is
    // the whole assertion: an unset issuer means "this path is off", never
    // "accept whoever signed it".
    const saved = (env as unknown as Record<string, unknown>).HUB_ISSUER;
    delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
    try {
      const res = await SELF.fetch('https://api.test/v1/agents', {
        headers: { Authorization: `Bearer ${await hubToken()}` },
      });
      expect(res.status).toBe(401);
    } finally {
      if (saved !== undefined) (env as unknown as Record<string, unknown>).HUB_ISSUER = saved;
    }
  });

  it('still refuses an unauthenticated request', async () => {
    const res = await SELF.fetch('https://api.test/v1/agents');
    expect(res.status).toBe(401);
  });

  it('leaves the existing credentials working', async () => {
    // The whole point of "additive". A dev-header caller must be unaffected by
    // the new branch, which only runs when the others have already declined.
    const res = await SELF.fetch('https://api.test/v1/agents', {
      headers: { 'X-Tenant-Id': TENANT },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('agents');
  });

  it('does not accept a hub token on POST, only on the read', async () => {
    // Independent of whether an issuer is configured: this must refuse either
    // way, so the issuer is removed to keep the case about the one thing it
    // names.
    const saved = (env as unknown as Record<string, unknown>).HUB_ISSUER;
    delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
    try {
    // A first integration should not also be the first credential able to mint
    // an agent token.
    const res = await SELF.fetch('https://api.test/v1/agents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await hubToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'should not be created' }),
    });
    expect(res.status).toBe(401);
    } finally {
      if (saved !== undefined) (env as unknown as Record<string, unknown>).HUB_ISSUER = saved;
    }
  });

  it('authorizes a real hub token, resolving to the same tenant a dev caller gets', async () => {
    // The positive half, and the one the issue actually asks for. Two things are
    // arranged so the Worker can verify without a network: HUB_ISSUER is set on
    // the shared env, and the global fetch serves the JWKS — the test and the
    // Worker run in the same isolate under vitest-pool-workers.
    const realFetch = globalThis.fetch;
    (env as unknown as Record<string, unknown>).HUB_ISSUER = issuerOrigin;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `${issuerOrigin}/api/auth/jwks`) {
        return new Response(jwksBody, { headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    try {
      const viaHub = await SELF.fetch('https://api.test/v1/agents', {
        headers: { Authorization: `Bearer ${await hubToken()}` },
      });
      expect(viaHub.status).toBe(200);

      // Same principal, same tenant: nothing downstream can tell which
      // credential arrived.
      const viaDev = await SELF.fetch('https://api.test/v1/agents', {
        headers: { 'X-Tenant-Id': TENANT },
      });
      expect(await viaHub.json()).toEqual(await viaDev.json());
    } finally {
      globalThis.fetch = realFetch;
      delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
    }
  });

  it('refuses a verified token whose tenant maps to no board here', async () => {
    const realFetch = globalThis.fetch;
    (env as unknown as Record<string, unknown>).HUB_ISSUER = issuerOrigin;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `${issuerOrigin}/api/auth/jwks`) {
        return new Response(jwksBody, { headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    try {
      // Verifies perfectly; names a boundary nothing here is mapped to. There is
      // no tenant to act in, and a default would hand one board's data to a
      // token that never named it.
      const res = await SELF.fetch('https://api.test/v1/agents', {
        headers: { Authorization: `Bearer ${await hubToken({ tenant: 'fleet_00000000000000000404' })}` },
      });
      expect(res.status).toBe(401);
    } finally {
      globalThis.fetch = realFetch;
      delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
    }
  });

  it('never lets a hub token through as a kbn_ agent credential', async () => {
    // Independent of whether an issuer is configured: this must refuse either
    // way, so the issuer is removed to keep the case about the one thing it
    // names.
    const saved = (env as unknown as Record<string, unknown>).HUB_ISSUER;
    delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
    try {
    // `kbn_` is the agent credential and is resolved from the catalog by hash.
    // A JWT that happened to start with that prefix must not be looked up as one.
    const res = await SELF.fetch('https://api.test/v1/agents', {
      headers: { Authorization: `Bearer kbn_${await hubToken()}` },
    });
    expect(res.status).toBe(401);
    } finally {
      if (saved !== undefined) (env as unknown as Record<string, unknown>).HUB_ISSUER = saved;
    }
  });
  /**
   * A station token is NOT a human credential.
   *
   * `charter → decisions/2026-08-30-an-agent-is-a-principal.md` lets a node exchange
   * `<nodeId>:<nodeSecret>` for a short-lived hub token whose `principalKind` is `"agent"`.
   * `index.ts` makes `resolveHubUser` the fallback for every non-agent route, so without a
   * kind check that token signs in as a PERSON — on board creation, card creation, gate
   * resolution — carrying `mayDispatch` as though someone had authorised it. Worse, that path
   * needs no local `agents` row at all: it only needs the claim's tenant to map, so the
   * org-plane mapping is no barrier.
   *
   * `resolveHubAgent` has refused the converse from the start ("a human's token must never
   * double as an agent credential"). These two cases hold the mirror of that.
   */
  async function withIssuer(fn: () => Promise<void>): Promise<void> {
    const realFetch = globalThis.fetch;
    (env as unknown as Record<string, unknown>).HUB_ISSUER = issuerOrigin;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `${issuerOrigin}/api/auth/jwks`) {
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

  /** Exactly what the station-token exchange mints: a bare principal id, kind `agent`. */
  const stationToken = () =>
    hubToken({ sub: 'prn_0000000000000000stn1', principalKind: 'agent', act: { sub: 'nod_1' } });

  it('refuses a station-style agent token on a human read', async () => {
    await withIssuer(async () => {
      // The token verifies and its tenant maps — everything `resolveHubUser` used to check.
      // The kind is the only thing standing between a node's credential and a person's reach.
      const res = await SELF.fetch('https://api.test/v1/agents', {
        headers: { Authorization: `Bearer ${await stationToken()}` },
      });
      expect(res.status).toBe(401);
    });
  });

  it('refuses a station-style agent token on a human WRITE', async () => {
    await withIssuer(async () => {
      // The read above is the smaller half. This is the one that matters: board creation is a
      // human route reached with `mayDispatch` attached, and no `agents` row is involved
      // anywhere on this path.
      const res = await SELF.fetch('https://api.test/v1/boards', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await stationToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'minted by a node', stages: [] }),
      });
      expect(res.status).toBe(401);
    });
  });

  it('still admits a human-kind token on the same routes', async () => {
    // The refusal above must be about the KIND and nothing else — otherwise it would pass just
    // as well by breaking the hub path entirely.
    await withIssuer(async () => {
      const res = await SELF.fetch('https://api.test/v1/agents', {
        headers: { Authorization: `Bearer ${await hubToken()}` },
      });
      expect(res.status).toBe(200);
    });
  });
});

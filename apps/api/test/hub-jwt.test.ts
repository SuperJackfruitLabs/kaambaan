import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { setupCatalog } from './helpers/catalog';
import { verifyHubToken, __resetJwksCacheForTests } from '../src/auth/hub-jwt';
import { findTenantByExternal } from '../src/db/catalog';

/**
 * Verifying a hub-issued token at the edge.
 *
 * The consumer half of charter's decisions/2026-08-15-one-issuer-and-offline-verification.md.
 * These run in the real Workers runtime (@cloudflare/vitest-pool-workers), which
 * is the point: the property being proved is that a request can be authorized
 * here with **no network call**, which is what
 * decisions/2026-08-13-ecosystem-identity.md requires — enforcement local, the
 * token as carrier, and explicitly not a policy-service call in the hot path.
 *
 * The claim names come from the shared corpus
 * (agentpod fixtures/ecosystem-identity/token_claims.json), not from reading the
 * hub's source. If the two ever disagree, that is the bug this arrangement
 * exists to catch — a rename in the hub is otherwise a silent authorization
 * failure here, and it fails in the direction that looks like the caller simply
 * having no permission.
 */

const ISSUER = 'https://hub.agentpod.dev';
const FLEET = 'fleet_0123456789abcdef0123';

let signingKey: CryptoKey;
let jwks: { keys: unknown[] };
let fetchCount = 0;

/** The issuer, faked precisely: same algorithm (EdDSA), same claim names. */
async function makeToken(over: Record<string, unknown> = {}, kid = 'test-kid') {
  const payload: Record<string, unknown> = {
    sub: 'user_abc',
    principalKind: 'human',
    tenant: FLEET,
    ...over,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime(over.exp === undefined ? '5m' : (over.exp as string))
    .sign(signingKey);
}

/** Serves the JWKS and counts every fetch, so "offline" is measured, not claimed. */
function countingFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    fetchCount++;
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/auth/jwks')) {
      return new Response(JSON.stringify(jwks), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

beforeAll(async () => {
  await setupCatalog();
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  const pub = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...pub, alg: 'EdDSA', kid: 'test-kid' }] };
});

describe('verifying a hub token at the edge', () => {
  it('accepts a well-formed token and returns its claims', async () => {
    __resetJwksCacheForTests();
    fetchCount = 0;
    const claims = await verifyHubToken(await makeToken(), {
      issuer: ISSUER,
      fetch: countingFetch(),
    });

    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('user_abc');
    expect(claims!.tenant).toBe(FLEET);
    expect(claims!.principalKind).toBe('human');
  });

  it('makes no network call once the key set is cached', async () => {
    // The load-bearing property. If verification reached the issuer per request,
    // every board read would depend on the hub being up and add a hop.
    __resetJwksCacheForTests();
    fetchCount = 0;
    await verifyHubToken(await makeToken(), { issuer: ISSUER, fetch: countingFetch() });
    const afterFirst = fetchCount;

    await verifyHubToken(await makeToken(), { issuer: ISSUER, fetch: countingFetch() });
    await verifyHubToken(await makeToken(), { issuer: ISSUER, fetch: countingFetch() });

    expect(afterFirst).toBe(1);
    expect(fetchCount).toBe(1); // still one: the next two verified offline
  });

  it('keeps working when the issuer is unreachable', async () => {
    // agentpod#331 proved this against a killed issuer. Asserted here so the
    // property cannot regress: an issuer outage must degrade new sign-ins, not
    // stop work in flight.
    __resetJwksCacheForTests();
    await verifyHubToken(await makeToken(), { issuer: ISSUER, fetch: countingFetch() });

    const dead = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const claims = await verifyHubToken(await makeToken(), { issuer: ISSUER, fetch: dead });
    expect(claims).not.toBeNull();
  });

  it('verifies a token signed by a key rotated in after the cache was warm', async () => {
    // The regression the spike found: retiring/adding a key on the issuer's
    // side does not invalidate anything, and a freshly minted token signed by
    // a just-published key must verify — even though our cache doesn't know
    // about it yet — by refetching once, not by waiting out the 10-minute TTL.
    __resetJwksCacheForTests();
    fetchCount = 0;
    const originalJwks = jwks;
    try {
      await verifyHubToken(await makeToken(), { issuer: ISSUER, fetch: countingFetch() });
      expect(fetchCount).toBe(1); // cache is now warm

      const rotatedIn = await generateKeyPair('EdDSA', { extractable: true });
      const rotatedPub = await exportJWK(rotatedIn.publicKey);
      jwks = {
        keys: [...originalJwks.keys, { ...rotatedPub, alg: 'EdDSA', kid: 'rotated-in-kid' }],
      };

      const rotatedToken = await new SignJWT({
        sub: 'user_abc',
        principalKind: 'human',
        tenant: FLEET,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'rotated-in-kid' })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(ISSUER)
        .setExpirationTime('5m')
        .sign(rotatedIn.privateKey);

      const claims = await verifyHubToken(rotatedToken, { issuer: ISSUER, fetch: countingFetch() });
      expect(claims).not.toBeNull();
      expect(claims!.sub).toBe('user_abc');
      expect(fetchCount).toBe(2); // exactly one refetch, triggered by the unknown kid
    } finally {
      jwks = originalJwks;
    }
  });

  it('rejects a kid that exists nowhere, after at most one refetch', async () => {
    __resetJwksCacheForTests();
    fetchCount = 0;
    await verifyHubToken(await makeToken(), { issuer: ISSUER, fetch: countingFetch() });
    expect(fetchCount).toBe(1); // cache is now warm

    const ghost = await generateKeyPair('EdDSA', { extractable: true });
    const ghostToken = await new SignJWT({ sub: 'user_abc', principalKind: 'human', tenant: FLEET })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'ghost-kid-nowhere' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setExpirationTime('5m')
      .sign(ghost.privateKey);

    const claims = await verifyHubToken(ghostToken, { issuer: ISSUER, fetch: countingFetch() });
    expect(claims).toBeNull();
    expect(fetchCount).toBe(2); // exactly one refetch, no retry loop
  });

  it('does not refetch for a bad signature or an expired token carrying a known kid', async () => {
    // The flip side of refetch-on-unknown-kid: these have a `kid` we already
    // hold, so the failure is discovered without ever touching the network.
    // Otherwise a flood of malformed tokens becomes a flood of requests
    // against the issuer.
    __resetJwksCacheForTests();
    fetchCount = 0;
    await verifyHubToken(await makeToken(), { issuer: ISSUER, fetch: countingFetch() });
    expect(fetchCount).toBe(1); // cache is now warm, and knows 'test-kid'

    const other = await generateKeyPair('EdDSA', { extractable: true });
    const badSignature = await new SignJWT({ sub: 'user_evil', principalKind: 'human', tenant: FLEET })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setExpirationTime('5m')
      .sign(other.privateKey);

    expect(
      await verifyHubToken(badSignature, { issuer: ISSUER, fetch: countingFetch() })
    ).toBeNull();
    expect(fetchCount).toBe(1); // no refetch for a bad signature

    const expired = await new SignJWT({ sub: 'user_abc', principalKind: 'human', tenant: FLEET })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(signingKey);

    expect(await verifyHubToken(expired, { issuer: ISSUER, fetch: countingFetch() })).toBeNull();
    expect(fetchCount).toBe(1); // still no refetch for an expired token
  });

  it('rejects rather than admits a token when the refetch itself fails', async () => {
    // Fail closed: an unknown kid whose refetch cannot reach the issuer must
    // not fall back to the stale set (which, by definition, is exactly the
    // set that doesn't have this key) and must not be treated as valid.
    __resetJwksCacheForTests();
    await verifyHubToken(await makeToken(), { issuer: ISSUER, fetch: countingFetch() }); // warm

    const unknown = await generateKeyPair('EdDSA', { extractable: true });
    const tokenWithUnknownKid = await new SignJWT({
      sub: 'user_abc',
      principalKind: 'human',
      tenant: FLEET,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'unreachable-refetch-kid' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setExpirationTime('5m')
      .sign(unknown.privateKey);

    const dead = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const claims = await verifyHubToken(tokenWithUnknownKid, { issuer: ISSUER, fetch: dead });
    expect(claims).toBeNull();
  });

  it('shares one refetch across concurrent verifications of the same unknown kid', async () => {
    __resetJwksCacheForTests();
    fetchCount = 0;
    const originalJwks = jwks;
    try {
      await verifyHubToken(await makeToken(), { issuer: ISSUER, fetch: countingFetch() });
      expect(fetchCount).toBe(1); // warm

      const rotatedIn = await generateKeyPair('EdDSA', { extractable: true });
      const rotatedPub = await exportJWK(rotatedIn.publicKey);
      jwks = {
        keys: [...originalJwks.keys, { ...rotatedPub, alg: 'EdDSA', kid: 'concurrent-rotated-kid' }],
      };

      const rotatedToken = await new SignJWT({
        sub: 'user_abc',
        principalKind: 'human',
        tenant: FLEET,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'concurrent-rotated-kid' })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(ISSUER)
        .setExpirationTime('5m')
        .sign(rotatedIn.privateKey);

      const shared = countingFetch();
      const [a, b] = await Promise.all([
        verifyHubToken(rotatedToken, { issuer: ISSUER, fetch: shared }),
        verifyHubToken(rotatedToken, { issuer: ISSUER, fetch: shared }),
      ]);

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(fetchCount).toBe(2); // one refetch shared by both, not two
    } finally {
      jwks = originalJwks;
    }
  });

  it('refuses a token signed by a key that is not in the set', async () => {
    __resetJwksCacheForTests();
    const other = await generateKeyPair('EdDSA', { extractable: true });
    const forged = await new SignJWT({ sub: 'user_evil', principalKind: 'human', tenant: FLEET })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setExpirationTime('5m')
      .sign(other.privateKey);

    expect(await verifyHubToken(forged, { issuer: ISSUER, fetch: countingFetch() })).toBeNull();
  });

  it('refuses an expired token', async () => {
    // The revocation SLA. agentpod#331 established that a token issued before a
    // session is revoked stays valid until it expires, so expiry is the only
    // thing standing between a stolen token and an unbounded one.
    __resetJwksCacheForTests();
    const expired = await new SignJWT({ sub: 'user_abc', principalKind: 'human', tenant: FLEET })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(signingKey);

    expect(await verifyHubToken(expired, { issuer: ISSUER, fetch: countingFetch() })).toBeNull();
  });

  it('refuses a token from another issuer', async () => {
    __resetJwksCacheForTests();
    const wrong = await new SignJWT({ sub: 'user_abc', principalKind: 'human', tenant: FLEET })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid' })
      .setIssuedAt()
      .setIssuer('https://not-our-hub.example.com')
      .setAudience(ISSUER)
      .setExpirationTime('5m')
      .sign(signingKey);

    expect(await verifyHubToken(wrong, { issuer: ISSUER, fetch: countingFetch() })).toBeNull();
  });

  it('refuses a token that names no tenant', async () => {
    // Not a weaker caller — an unresolvable one. Falling back to a default
    // boundary here would hand one tenant's data to a token that never named it.
    __resetJwksCacheForTests();
    const noTenant = await new SignJWT({ sub: 'user_abc', principalKind: 'human' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setExpirationTime('5m')
      .sign(signingKey);

    expect(await verifyHubToken(noTenant, { issuer: ISSUER, fetch: countingFetch() })).toBeNull();
  });

  it('refuses an unsigned token', async () => {
    // `alg: none`. The algorithm is pinned rather than read from the header.
    __resetJwksCacheForTests();
    const header = btoa(JSON.stringify({ alg: 'none', kid: 'test-kid' }))
      .replace(/=+$/, '');
    const body = btoa(JSON.stringify({ sub: 'user_evil', tenant: FLEET, iss: ISSUER }))
      .replace(/=+$/, '');

    expect(
      await verifyHubToken(`${header}.${body}.`, { issuer: ISSUER, fetch: countingFetch() })
    ).toBeNull();
  });
});

describe('mapping the hub tenant onto kaambaan (the external mapping)', () => {
  it("resolves a fleet_ id to this board's own tenant", async () => {
    // The claim carries AgentPod's boundary (`fleet_…`). kaambaan's is `tnt_…`,
    // and neither product mints the other's id — migration 0002 exists precisely
    // so the same real organisation can be recognised across the two.
    const tenantId = await findTenantByExternal(env.DB, 'agentpod', FLEET);
    expect(tenantId).toBeNull(); // nothing mapped yet in a fresh catalog

    // A board of our own to map. The catalog starts empty here, and an UPDATE
    // against no rows silently maps nothing — which then reads as "the lookup
    // is broken" rather than "there was nothing to find".
    await env.DB.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_maptest', 'maptest', 'Map Test')`
    ).run();
    await env.DB.prepare(
      `UPDATE tenants SET external_source = 'agentpod', external_id = ? WHERE id = 'tnt_maptest'`
    ).bind(FLEET).run();

    const mapped = await findTenantByExternal(env.DB, 'agentpod', FLEET);
    expect(mapped).toMatch(/^tnt_/);
  });

  it('does not match an id from a different source', async () => {
    // external_id without external_source is meaningless, and a bare id could
    // belong to any system. Both halves must match.
    expect(await findTenantByExternal(env.DB, 'org-plane', FLEET)).toBeNull();
  });
});

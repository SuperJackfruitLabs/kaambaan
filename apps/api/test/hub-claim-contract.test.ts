/**
 * The claim NAMES superpipeline depends on, pinned here so a rename upstream fails a test.
 *
 * agentpod's `fixtures/ecosystem-identity/token_claims.json` is the contract, and its own
 * `purpose` field says why it exists: "The moment a second plane reads a claim, the claim's NAME
 * is a contract: a rename in the hub is a silent authorization failure in superpipeline, which
 * fails in the direction that looks like the caller having no permission."
 *
 * superpipeline is that second plane, and until this file the fixture reached it only as prose in
 * comments — no copy, no test, no cross-repo CI step. A rename touching agentpod's code, fixture
 * and tests would have been green in both repositories and a silent 403 in production: exactly the
 * failure the fixture exists to prevent, arriving through the one gap the fixture cannot cover on
 * its own.
 *
 * This is the MINIMAL half of closing that: the names this repository reads, asserted against a
 * token, plus the fixture's version. Vendoring the fixture and running a drift job against the
 * upstream copy is a separate, larger change — deliberately not built here.
 *
 * **When either assertion fails, the fix is never to edit the expectation alone.** Read the
 * upstream fixture, work out what moved, and change the consumer — `hub-jwt.ts`, `hub-oauth.ts`,
 * `resolve.ts` — to match before touching anything below.
 */
import { describe, it, expect } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { verifyHubToken, __resetJwksCacheForTests, type HubClaims } from '../src/auth/hub-jwt';

/**
 * `version` of agentpod `fixtures/ecosystem-identity/token_claims.json`, as of 2026-10-04 — the
 * revision that added the conditional `scope` claim (superwitness service tokens). v6 added
 * `email` / `email_verified` for the suite sign-in programme.
 *
 * Pinned as a bare number on purpose. Nothing here can read the upstream file (it lives in another
 * repository, and CI for this one never checks that one out), so this constant is the visible
 * diff: bumping it is the moment somebody has to have looked at what changed. A pin that is never
 * touched is a pin that was never checked, which is why the assertion below carries the
 * instructions for updating it.
 */
const FIXTURE_VERSION = 7;

/**
 * Every claim name this repository reads out of a hub token, and where it is read.
 *
 * `sub`, `principalKind` and `tenant` are `issued` in the fixture — required of every token.
 * `email` and `email_verified` are `conditional` — a consumer must not require them, which is why
 * `hub-oauth.ts` resolves an already-mapped user from `sub` alone. `act` is conditional too and is
 * deliberately NOT in this list: nothing reads it for a decision, and `signInFromHubToken` refuses
 * a token that carries it rather than interpreting it.
 */
const CLAIMS_READ = {
  sub: 'hub-oauth.ts step 1, resolve.ts — the mapping key (the issuer SUBJECT id, not a `prn_`)',
  principalKind: 'hub-oauth.ts and resolve.ts — the human-only refusal',
  tenant: 'resolve.ts and hub-oauth.ts step 3 — the fleet mapping',
  email: 'hub-oauth.ts step 2 — the adoption key',
  email_verified: 'hub-oauth.ts step 2 — the verdict the adoption is gated on',
  scope: 'resolve.ts resolveHubService — evidence:read for a service principal (superwitness)',
} as const;

const ISSUER = 'https://hub.claim-contract.test';

/**
 * The origin this Worker answers on in these tests, and therefore the audience a hub token
 * must name (`auth/hub-jwt.ts`, `planeAudience`). Before 2026-09-20 the check asked for the
 * issuer, which every token carries, so `aud` was decoration here.
 */
const PLANE = 'https://api.test';
const KID = 'claim-contract-kid';

let issuerOnce: Promise<{ signingKey: CryptoKey; jwksBody: string }> | null = null;
function issuerKeys() {
  issuerOnce ??= (async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    const jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: KID }] });
    return { signingKey: pair.privateKey, jwksBody };
  })();
  return issuerOnce;
}

async function verifiedClaimsOf(payload: Record<string, unknown>): Promise<HubClaims | null> {
  const { signingKey, jwksBody } = await issuerKeys();
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: KID })
    .setIssuer(ISSUER)
    .setAudience([ISSUER, PLANE])
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
  __resetJwksCacheForTests();
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input) === `${ISSUER}/api/auth/jwks`) {
      return new Response(jwksBody, { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('no', { status: 404 });
  }) as unknown as typeof fetch;
  return verifyHubToken(token, { issuer: ISSUER, audience: PLANE, fetch: fetchImpl });
}

/** A token spelled exactly as the fixture spells it. */
const CONTRACT_TOKEN = {
  sub: '68jYD9VOCmXlPhIY',
  principalKind: 'human',
  tenant: 'fleet_0000000000000000cafe',
  email: 'contract@example.com',
  email_verified: true,
  scope: 'evidence:read',
} as const;

describe('the hub claim contract, as this plane reads it', () => {
  it('pins the fixture version it was written against', () => {
    // A bump upstream is not a failure here — it is a prompt. Diff
    // `fixtures/ecosystem-identity/token_claims.json` between the two versions, make the consumer
    // agree with it, and only then move this number.
    expect(
      FIXTURE_VERSION,
      'agentpod fixtures/ecosystem-identity/token_claims.json changed version: read the diff, fix the consumer, then bump this',
    ).toBe(7);
  });

  it('reads every claim it depends on, under the exact name the fixture gives it', async () => {
    const claims = await verifiedClaimsOf({ ...CONTRACT_TOKEN });
    expect(claims).not.toBeNull();
    for (const name of Object.keys(CLAIMS_READ) as (keyof typeof CLAIMS_READ)[]) {
      expect(claims?.[name], `${name} — ${CLAIMS_READ[name]}`).toBe(CONTRACT_TOKEN[name]);
    }
  });

  it('refuses a token that renames any REQUIRED claim', async () => {
    // The point of the previous test is only made by this one. `verifyHubToken` requires `sub`,
    // `principalKind` and `tenant` by those exact spellings, so a rename upstream does not
    // degrade anything here — it stops every hub token verifying at all. Loud, and the least bad
    // of the two shapes a rename can take.
    for (const [name, alias] of [
      ['sub', 'subject'],
      ['principalKind', 'principal_kind'],
      ['tenant', 'fleet'],
    ] as const) {
      const payload: Record<string, unknown> = { ...CONTRACT_TOKEN };
      payload[alias] = payload[name];
      delete payload[name];
      expect(
        await verifiedClaimsOf(payload),
        `${name} renamed to ${alias} must not verify — ${CLAIMS_READ[name]}`,
      ).toBeNull();
    }
  });

  it('reads a renamed CONDITIONAL claim as absent, which is the silent failure', async () => {
    // `email` and `email_verified` are conditional, so nothing may require them — which means a
    // rename of either verifies perfectly and simply is not there. That is the dangerous shape:
    // adoption stops happening, a second account gets created instead, and nothing anywhere says
    // why. These two names are the reason this file exists.
    for (const [name, alias] of [
      ['email', 'emailAddress'],
      ['email_verified', 'emailVerified'],
    ] as const) {
      const payload: Record<string, unknown> = { ...CONTRACT_TOKEN };
      payload[alias] = payload[name];
      delete payload[name];
      const claims = await verifiedClaimsOf(payload);
      expect(claims, `a token renaming ${name} still verifies — that is the danger`).not.toBeNull();
      expect(
        claims?.[name],
        `${name} renamed to ${alias} silently reads as absent — ${CLAIMS_READ[name]}`,
      ).toBeUndefined();
    }
  });
});

/**
 * `/v1/labels[/:id]` with a hub JWT — the CLI's actual auth path.
 *
 * `supi label list|add|rm` all send `Authorization: Bearer <hub JWT>` (packages/cli/src/index.ts),
 * which only `resolveHubUser` can read. `/v1/labels` resolved the caller with `resolveUser` alone
 * (session cookie or dev headers), so every one of those verbs 401'd and told the person to run
 * `fleet login` — which cannot help, because the credential was never the problem.
 *
 * Every other CLI-reachable route (capabilities, implications, agents, all board routes) falls
 * back to `resolveHubUser` when `resolveUser` finds nothing. Labels was the one session-only
 * exception with CLI verbs pointed at it. Unlike capabilities/implications (read-only fallback,
 * `capabilities-hub-read.test.ts`), the label catalogue's write verbs (`add`, `rm`) are also
 * CLI-reachable, so the fallback here is unconditional on method — `refuseByRole(u, 'manage')`
 * is what gates the writes, exactly as it already gates a session-authenticated write.
 */
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { addMember } from '../src/db/members';
import { setTenantExternalMapping, setUserExternalMapping } from '../src/db/catalog';
import { withIssuer } from './helpers/hub-issuer';

const ISSUER = 'https://issuer.test';
const PLANE = 'https://api.test';
const FLEET = 'fleet_0000000000000lblhub';
const TENANT = 'tnt_lbl_hub';
const KID = 'lbl-hub-kid';

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
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'LabelsHub')`)
    .bind(TENANT, `slug-${TENANT}`)
    .run();
  await setTenantExternalMapping(env.DB, TENANT, { externalId: FLEET, externalSource: 'agentpod' });
  const user = await addMember(env.DB, TENANT, { email: 'lbl-hub-owner@example.com', role: 'owner' });
  await setUserExternalMapping(env.DB, user.userId, { externalId: 'prn_lbl_hub', externalSource: 'agentpod' });
}

describe('a hub token may use the label catalogue, matching every other CLI-reachable route', () => {
  it('GET /v1/labels answers a hub token (this is `supi label list`)', async () => {
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_lbl_hub');
      const res = await SELF.fetch('https://api.test/v1/labels', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status, 'a terminal must be able to list the label catalogue').toBe(200);
      const body = await res.json<{ labels: unknown[] }>();
      expect(Array.isArray(body.labels)).toBe(true);
    });
  });

  it('POST /v1/labels answers a hub token (this is `supi label add`)', async () => {
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_lbl_hub');
      const res = await SELF.fetch('https://api.test/v1/labels', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'from-cli', colour: '#123456' }),
      });
      expect(res.status, 'a terminal must be able to declare a label').toBe(201);
    });
  });

  it('DELETE /v1/labels/:id answers a hub token (this is `supi label rm`)', async () => {
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_lbl_hub');
      const made = await SELF.fetch('https://api.test/v1/labels', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'to-remove', colour: '#654321' }),
      });
      const { label } = await made.json<{ label: { id: string } }>();

      const res = await SELF.fetch(`https://api.test/v1/labels/${label.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(204);
    });
  });
});

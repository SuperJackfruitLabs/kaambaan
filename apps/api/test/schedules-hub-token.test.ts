/**
 * `/v1/boards/:id/schedules[/:scheduleId]` with a hub JWT — the CLI's actual auth path.
 *
 * `supi schedule list|add|rm|pause|resume` all send `Authorization: Bearer <hub JWT>`
 * (packages/cli/src/index.ts's `api()`), which only `resolveHubUser` can read. Phase 1 shipped
 * `/v1/labels` resolving its caller with `resolveUser` alone (session cookie or dev headers), so
 * every `supi label` verb 401'd and told the person to run `fleet login` — which could not help,
 * because the credential was never the problem. It was found only by a whole-branch review,
 * because the route's own tests passed and the CLI's own tests only asserted the verb dispatched.
 *
 * The board subroutes (this file's target) already fall back to `resolveHubUser` unconditionally
 * for every method (`apps/api/src/index.ts`, the `else` branch above `const stub = boardStub(...)`)
 * — this test drives that fallback with a real hub JWT rather than assuming the pattern holds.
 * Modelled directly on `labels-hub-token.test.ts`.
 */
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { addMember } from '../src/db/members';
import { setTenantExternalMapping, setUserExternalMapping } from '../src/db/catalog';

const ISSUER = 'https://issuer.test';
const PLANE = 'https://api.test';
const FLEET = 'fleet_0000000000000schhub';
const TENANT = 'tnt_sch_hub';
const KID = 'sch-hub-kid';

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

async function linkedOwner(): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'SchedulesHub')`)
    .bind(TENANT, `slug-${TENANT}`)
    .run();
  await setTenantExternalMapping(env.DB, TENANT, { externalId: FLEET, externalSource: 'agentpod' });
  const user = await addMember(env.DB, TENANT, { email: 'sch-hub-owner@example.com', role: 'owner' });
  await setUserExternalMapping(env.DB, user.userId, { externalId: 'prn_sch_hub', externalSource: 'agentpod' });
}

describe('a hub token may manage a board\'s schedules, matching every other CLI-reachable board route', () => {
  it('POST /v1/boards answers a hub token, so a board exists to schedule against (this is `supi create-board`)', async () => {
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_sch_hub');
      const res = await SELF.fetch('https://api.test/v1/boards', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hub board', stages: [{ key: 'draft', name: 'Draft' }] }),
      });
      expect(res.status).toBe(201);
    });
  });

  it('POST /v1/boards/:id/schedules answers a hub token (this is `supi schedule add`)', async () => {
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_sch_hub');
      const board = await SELF.fetch('https://api.test/v1/boards', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hub board 2', stages: [{ key: 'draft', name: 'Draft' }] }),
      });
      const { boardId } = await board.json<{ boardId: string }>();

      const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/schedules`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Sweep', rule: 'daily at 09:00', timezone: 'UTC' }),
      });
      expect(res.status, 'a terminal must be able to add a schedule').toBe(201);
      const { schedule } = await res.json<{ schedule: { id: string; createdBy?: string } }>();
      expect(schedule.id).toMatch(/^sch_/);
    });
  });

  it('GET /v1/boards/:id/schedules answers a hub token (this is `supi schedule list`)', async () => {
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_sch_hub');
      const board = await SELF.fetch('https://api.test/v1/boards', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hub board 3', stages: [{ key: 'draft', name: 'Draft' }] }),
      });
      const { boardId } = await board.json<{ boardId: string }>();

      const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/schedules`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ schedules: unknown[] }>();
      expect(Array.isArray(body.schedules)).toBe(true);
    });
  });

  it('PATCH /v1/boards/:id/schedules/:id answers a hub token (this is `supi schedule pause`/`resume`)', async () => {
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_sch_hub');
      const board = await SELF.fetch('https://api.test/v1/boards', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hub board 4', stages: [{ key: 'draft', name: 'Draft' }] }),
      });
      const { boardId } = await board.json<{ boardId: string }>();
      const made = await SELF.fetch(`https://api.test/v1/boards/${boardId}/schedules`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Sweep', rule: 'daily at 09:00', timezone: 'UTC' }),
      });
      const { schedule } = await made.json<{ schedule: { id: string } }>();

      const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      expect((await res.json<{ schedule: { enabled: boolean } }>()).schedule.enabled).toBe(false);
    });
  });

  it('DELETE /v1/boards/:id/schedules/:id answers a hub token (this is `supi schedule rm`)', async () => {
    await linkedOwner();
    const { signingKey, jwksBody } = await newIssuer();
    await withIssuer(jwksBody, async () => {
      const token = await hubToken(signingKey, 'prn_sch_hub');
      const board = await SELF.fetch('https://api.test/v1/boards', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hub board 5', stages: [{ key: 'draft', name: 'Draft' }] }),
      });
      const { boardId } = await board.json<{ boardId: string }>();
      const made = await SELF.fetch(`https://api.test/v1/boards/${boardId}/schedules`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Sweep', rule: 'daily at 09:00', timezone: 'UTC' }),
      });
      const { schedule } = await made.json<{ schedule: { id: string } }>();

      const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/schedules/${schedule.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(204);
    });
  });
});

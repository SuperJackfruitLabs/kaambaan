/**
 * A gate resolved by a hub-issued token records the HUMAN as the decider.
 *
 * This is the assertion `charter` →
 * `decisions/2026-08-14-approvals-cross-planes-as-events.md` exists to protect.
 * Its reasoning, verbatim: if the bridge called with a single service
 * credential, "every gate decision in the suite would be 'decided by the
 * bridge' — the check would quietly stop meaning anything and every approval
 * would attribute to one account."
 *
 * Note what this does NOT prove. `decided_by` holds an AgentPod principal id
 * and `produced_by` a kaambaan agent id; those spaces never intersect, so
 * SEPARATION_OF_DUTIES passes vacuously on this path and is not exercised here.
 * The testable claim is narrower and is the one that matters: the board records
 * the person.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const PIPELINE = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
];

const ISSUER = 'https://issuer.test';
const FLEET = 'fleet_00000000000000000077';
const TENANT = 'tnt_gate_hub';
const HUMAN = 'usr_the_actual_person';

let signingKey: CryptoKey;
let jwksBody: string;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'g-kid' }] });
});

const dev = (user?: string) => ({
  'X-Tenant-Id': TENANT,
  ...(user ? { 'X-User-Id': user } : {}),
  'Content-Type': 'application/json',
});

async function hubToken(sub = HUMAN): Promise<string> {
  return new SignJWT({ sub, principalKind: 'human', tenant: FLEET, mayDispatch: ['kaambaan:*'] })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'g-kid' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime('5m')
    .sign(signingKey);
}

async function withIssuer(fn: () => Promise<void>, mapTenant = true) {
  const realFetch = globalThis.fetch;
  (env as unknown as Record<string, unknown>).HUB_ISSUER = ISSUER;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === `${ISSUER}/api/auth/jwks`) {
      return new Response(jwksBody, { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'GH')`)
    .bind(TENANT, `slug-${TENANT}`).run();
  await env.DB.prepare(`UPDATE tenants SET external_source=?, external_id=? WHERE id=?`)
    .bind(mapTenant ? 'agentpod' : null, mapTenant ? FLEET : null, TENANT).run();
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
    await env.DB.prepare(`UPDATE tenants SET external_source=NULL, external_id=NULL WHERE id=?`).bind(TENANT).run();
  }
}

/** Board, card, claim, complete — leaving the card on the review gate. */
async function openGate(name: string): Promise<{ boardId: string; gateId: string }> {
  const bRes = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST', headers: dev('usr_owner'),
    body: JSON.stringify({ name, stages: PIPELINE }),
  });
  const { boardId } = await bRes.json<{ boardId: string }>();

  await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
    method: 'POST', headers: dev('usr_owner'),
    body: JSON.stringify({ title: 'Add OAuth login' }),
  });
  const cRes = await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
    method: 'POST', headers: { ...dev(), 'X-Agent-Id': 'agt_researcher' },
    body: JSON.stringify({ capabilities: ['research'] }),
  });
  const claim = await cRes.json<{ claimed: boolean; runId: string; leaseEpoch: number }>();
  expect(claim.claimed, 'the researcher must claim before it can submit').toBe(true);

  await SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${claim.runId}/complete`, {
    method: 'POST', headers: { ...dev(), 'X-Agent-Id': 'agt_researcher' },
    body: JSON.stringify({ leaseEpoch: claim.leaseEpoch, handoff: { summary: 'drafted' } }),
  });

  const sRes = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: dev('usr_owner') });
  const state = await sRes.json<{ gates?: Array<{ id: string; status: string }> }>();
  const gate = (state.gates ?? []).find((g) => g.status === 'pending');
  expect(gate, 'completing research must open the review gate').toBeDefined();
  return { boardId, gateId: gate!.id };
}

describe('resolving a gate with a hub token', () => {
  it('records the token holder as the decider, not the bridge', async () => {
    await withIssuer(async () => {
      const { boardId, gateId } = await openGate('GH-approve');
      const res = await SELF.fetch(
        `https://api.test/v1/boards/${boardId}/gates/${gateId}/resolve`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${await hubToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approve' }),
        },
      );
      expect(res.status).toBe(200);

      // Read the row itself. `getState().gates` is `pendingGates()`, so a
      // resolved gate leaves the projection entirely — and `decided_by` is the
      // only thing this test is actually about.
      const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`${TENANT}:${boardId}`));
      await runInDurableObject(stub, async (board: unknown) => {
        const sql = (board as { sql: { exec: (q: string, ...p: unknown[]) => { one: () => Record<string, unknown> } } }).sql;
        const row = sql.exec(`SELECT status, decision, decided_by FROM gates WHERE id = ?`, gateId).one();
        expect(row.status).toBe('resolved');
        expect(row.decision).toBe('approve');
        expect(
          row.decided_by,
          "if this is ever the bridge's id, every approval in the suite attributes to one account",
        ).toBe(HUMAN);
      });
    });
  });

  it('carries the reviewer\'s comment into request_changes', async () => {
    await withIssuer(async () => {
      const { boardId, gateId } = await openGate('GH-changes');
      const res = await SELF.fetch(
        `https://api.test/v1/boards/${boardId}/gates/${gateId}/resolve`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${await hubToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'request_changes', comment: 'Add a refresh-token test.' }),
        },
      );
      expect(res.status).toBe(200);
      const card = (await res.json<{ card: { currentStageKey: string } }>()).card;
      // Back to the stage the work came from, for rework.
      expect(card.currentStageKey).toBe('research');
    });
  });

  it('refuses a second decision on a gate already resolved', async () => {
    // Two clients may render one gate, and a slow connection invites a
    // double-tap. Resolving twice must not advance the card twice.
    await withIssuer(async () => {
      const { boardId, gateId } = await openGate('GH-twice');
      const send = async () =>
        SELF.fetch(`https://api.test/v1/boards/${boardId}/gates/${gateId}/resolve`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await hubToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approve' }),
        });
      expect((await send()).status).toBe(200);
      const second = await send();
      expect(second.status).toBe(409);
      expect((await second.json<{ error: { code: string } }>()).error.code).toBe('GATE_NOT_PENDING');
    });
  });

  it('refuses a token whose tenant maps to no board here', async () => {
    // The correct refusal: a default boundary would hand one board's data to a
    // token that never named it. It reads as "not authorized" rather than "not
    // mapped", which is a poor diagnostic and a good security property.
    await withIssuer(async () => {
      const res = await SELF.fetch(
        `https://api.test/v1/boards/brd_nonexistent/gates/gate_x/resolve`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${await hubToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approve' }),
        },
      );
      expect(res.status).toBe(401);
    }, false);
  });
});

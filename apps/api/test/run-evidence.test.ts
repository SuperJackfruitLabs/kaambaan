/**
 * GET /v1/boards/:boardId/runs/:runId/evidence — superwitness's read of a run (contract C4).
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { z } from 'zod';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';
import type { BoardDO } from '../src/board/board-do';
import fixtureRaw from './fixtures/run-evidence.json?raw';
import { withIssuer } from './helpers/hub-issuer';

const fixture = JSON.parse(fixtureRaw) as { examples: Array<{ name: string; response: unknown }> };
const PIPELINE = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
];
const ISSUER = 'https://issuer-ev.test';
const PLANE = 'https://api.test';
const FLEET = 'fleet_0000000000000000ev01';
const TENANT = 'tnt_evidence';
const OTHER_TENANT = 'tnt_evidence_other';

const Iso = z.iso.datetime();
const Prn = z.string().regex(/^prn_[0-9a-f]{20}$/);
const RunEvidence = z.object({
  run: z.object({
    id: z.string(), board_id: z.string(), card_id: z.string(), stage_key: z.string(), agent_id: z.string(), agent_principal_id: Prn.nullable(),
    status: z.string(), outcome: z.string().nullable(), started_at: Iso, ended_at: Iso.nullable(),
  }).strict(),
  card: z.object({ id: z.string(), title: z.string(), stage_key: z.string() }).strict(),
  gates: z.array(z.object({
    id: z.string(), run_id: z.string().nullable(), stage_key: z.string(), status: z.enum(['pending', 'resolved', 'cancelled']),
    decision: z.enum(['approved', 'changes_requested', 'rejected']).nullable(), decided_by: z.string().nullable(),
    produced_by: z.string(), produced_by_principal_id: Prn.nullable(), decided_by_principal_id: Prn.nullable(),
    decided_by_hub_sub: z.string().min(1).nullable(), created_at: Iso, resolved_at: Iso.nullable(),
  }).strict()),
  usage: z.union([
    z.object({ status: z.literal('reported'), input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number() }).strict(),
    z.object({ status: z.literal('unreported'), input_tokens: z.null(), output_tokens: z.null(), cost_usd: z.null() }).strict(),
  ]),
  as_of: Iso,
}).strict();

function keyShape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [keyShape(v[0])] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, keyShape((v as Record<string, unknown>)[k])]));
  return 'scalar';
}

let signingKey: CryptoKey;
let jwksBody: string;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'ev-kid' }] });
  for (const t of [TENANT, OTHER_TENANT]) {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'E')`).bind(t, `slug-${t}`).run();
  }
  await env.DB.prepare(`UPDATE tenants SET external_source='agentpod', external_id=? WHERE id=?`).bind(FLEET, TENANT).run();
});
beforeEach(() => __resetJwksCacheForTests());

const hubToken = (over: Record<string, unknown> = {}) =>
  new SignJWT({ sub: 'prn_0123456789abcdef0e01', principalKind: 'service', tenant: FLEET, mayDispatch: [], mayGrantReach: false, scope: 'evidence:read', ...over })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'ev-kid' })
    .setIssuedAt().setIssuer(ISSUER).setAudience([ISSUER, PLANE]).setExpirationTime('5m')
    .sign(signingKey);

const dev = (tenant = TENANT, user = 'usr_owner') => ({ 'X-Tenant-Id': tenant, 'X-User-Id': user, 'Content-Type': 'application/json' });
const agent = (tenant = TENANT) => ({ ...dev(tenant), 'X-Agent-Id': 'agt_researcher' });

/** Board + card + claim; optionally report usage and complete. */
async function aRun(opts: { usage?: boolean; complete?: boolean; tenant?: string } = {}) {
  const tenant = opts.tenant ?? TENANT;
  const { boardId } = await (await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST', headers: dev(tenant), body: JSON.stringify({ name: 'ev', stages: PIPELINE }),
  })).json<{ boardId: string }>();
  await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: dev(tenant), body: JSON.stringify({ title: 'Add OAuth login' }) });
  const claim = await (await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
    method: 'POST', headers: agent(tenant), body: JSON.stringify({ capabilities: ['research'] }),
  })).json<{ runId: string; leaseEpoch: number }>();
  if (opts.usage) {
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${claim.runId}/activities`, {
      method: 'POST', headers: agent(tenant),
      body: JSON.stringify({ leaseEpoch: claim.leaseEpoch, type: 'response', body: 'done', usage: { model: 'kimi-k2', inputTokens: 120, outputTokens: 40, costUsd: 0.002 } }),
    });
  }
  if (opts.complete) {
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${claim.runId}/complete`, {
      method: 'POST', headers: agent(tenant), body: JSON.stringify({ leaseEpoch: claim.leaseEpoch, handoff: { summary: 'drafted' } }),
    });
  }
  return { boardId, runId: claim.runId };
}

const evidence = async (boardId: string, runId: string, token?: string) =>
  SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${runId}/evidence`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

describe('the fixture', () => {
  for (const ex of fixture.examples) {
    it(`parses: ${ex.name}`, () => {
      expect(RunEvidence.safeParse(ex.response).error).toBeUndefined();
    });
  }
});

describe('GET /v1/boards/:id/runs/:runId/evidence', () => {
  it('returns the run, its card, the gate it opened and its reported usage, in the fixture shape', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId, runId } = await aRun({ usage: true, complete: true });
      const res = await evidence(boardId, runId, await hubToken());
      expect(res.status).toBe(200);
      const body = await res.json<z.infer<typeof RunEvidence>>();
      expect(RunEvidence.safeParse(body).error).toBeUndefined();
      expect(keyShape(body)).toEqual(keyShape(fixture.examples[0]!.response));
      expect(body.run).toMatchObject({ id: runId, board_id: boardId, stage_key: 'research', outcome: 'completed' });
      expect(body.card.stage_key).toBe('review');
      expect(body.gates).toHaveLength(1);
      expect(body.gates[0]).toMatchObject({ run_id: runId, stage_key: 'review', status: 'pending', decision: null });
      expect(body.usage).toEqual({ status: 'reported', input_tokens: 120, output_tokens: 40, cost_usd: 0.002 });
    });
  });

  it('a run with no usage records says unreported, with null numbers — never zero', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId, runId } = await aRun();
      const body = await (await evidence(boardId, runId, await hubToken())).json<z.infer<typeof RunEvidence>>();
      expect(body.usage).toEqual({ status: 'unreported', input_tokens: null, output_tokens: null, cost_usd: null });
      expect(body.run.ended_at).toBeNull();
    });
  });

  it("a legacy gate (null run_id) on the run's card and stage is included; one on another stage is not", async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId, runId } = await aRun();
      const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`${TENANT}:${boardId}`)) as unknown as DurableObjectStub<BoardDO>;
      await runInDurableObject(stub, async (_b: BoardDO, state) => {
        const cardId = state.storage.sql.exec(`SELECT card_id FROM runs WHERE id = ?`, runId).toArray()[0]!.card_id as string;
        for (const [id, stage] of [['gate_legacysame', 'research'], ['gate_legacyother', 'publish']]) {
          state.storage.sql.exec(
            `INSERT INTO gates (id, card_id, stage_key, return_stage_key, status, decision, produced_by, decided_by, options_json, created_at, resolved_at)
             VALUES (?, ?, ?, ?, 'resolved', 'request_changes', 'agt_researcher', 'usr_reviewer', '[]', ?, ?)`,
            id, cardId, stage, stage, '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z',
          );
        }
      });
      const body = await (await evidence(boardId, runId, await hubToken())).json<z.infer<typeof RunEvidence>>();
      expect(body.gates.map((g) => g.id)).toEqual(['gate_legacysame']);
      expect(body.gates[0]).toMatchObject({ run_id: null, decision: 'changes_requested', decided_by: 'usr_reviewer' });
    });
  });

  it('an unknown run is 404 RUN_NOT_FOUND; an unknown board is 404 BOARD_NOT_FOUND', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId } = await aRun();
      const t = await hubToken();
      let res = await evidence(boardId, 'run_doesnotexist01', t);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'RUN_NOT_FOUND' } });
      res = await evidence('brd_0000000000000000', 'run_doesnotexist01', t);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'BOARD_NOT_FOUND' } });
    });
  });

  it('a board in another tenant is not found', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId, runId } = await aRun({ tenant: OTHER_TENANT });
      const res = await evidence(boardId, runId, await hubToken());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'BOARD_NOT_FOUND' } });
    });
  });

  it('an unmapped fleet is refused', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId, runId } = await aRun();
      expect((await evidence(boardId, runId, await hubToken({ tenant: 'fleet_ffffffffffffffffffff' }))).status).toBe(401);
    });
  });

  it('no token, a human token or an agent token is 401; a service without evidence:read is 403', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId, runId } = await aRun();
      expect((await evidence(boardId, runId)).status).toBe(401);
      expect((await evidence(boardId, runId, await hubToken({ principalKind: 'human' }))).status).toBe(401);
      expect((await evidence(boardId, runId, await hubToken({ principalKind: 'agent' }))).status).toBe(401);
      const res = await evidence(boardId, runId, await hubToken({ scope: undefined }));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });
  });
  it('a gate cancelled by a manual move is listed as cancelled, with no decision', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId, runId } = await aRun({ complete: true });
      const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`${TENANT}:${boardId}`)) as unknown as DurableObjectStub<BoardDO>;
      const cardId = await runInDurableObject(stub, async (_b: BoardDO, state) =>
        state.storage.sql.exec(`SELECT card_id FROM runs WHERE id = ?`, runId).toArray()[0]!.card_id as string);
      const mv = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${cardId}/move`, {
        method: 'POST', headers: dev(), body: JSON.stringify({ toStageKey: 'publish' }),
      });
      expect(mv.status).toBe(200);
      const body = await (await evidence(boardId, runId, await hubToken())).json<z.infer<typeof RunEvidence>>();
      expect(RunEvidence.safeParse(body).error).toBeUndefined();
      expect(body.gates).toHaveLength(1);
      expect(body.gates[0]).toMatchObject({ run_id: runId, stage_key: 'review', status: 'cancelled', decision: null, decided_by: null });
      expect(body.gates[0]!.resolved_at).not.toBeNull();
    });
  });

  it('a service token is the only way in: no token and an agent token on this path are not served', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId, runId } = await aRun();
      const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${runId}/evidence`, { headers: agent() });
      expect(res.status).toBe(401);
    });
  });
});

describe('principal ids on the evidence', () => {
  it('names the executing agent and the gate producer/decider when mapped; null when not', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { createAgent, setAgentExternalMapping, upsertUserByEmail, setUserExternalMapping } = await import('../src/db/catalog');
      const AGENT_PRN = 'prn_0123456789abcdef0a02';
      const USER_PRN = 'prn_0123456789abcdef0b02';
      const runner = await createAgent(env.DB, TENANT, { name: 'researcher', capabilities: ['research'] });
      await setAgentExternalMapping(env.DB, TENANT, runner.id, { externalId: AGENT_PRN, externalSource: 'org-plane' });
      const reviewer = await upsertUserByEmail(env.DB, { email: 'ev-reviewer@example.com' });
      await setUserExternalMapping(env.DB, reviewer.id, { externalId: USER_PRN, externalSource: 'agentpod' });

      const as = { ...dev(), 'X-Agent-Id': runner.id };
      const { boardId } = await (await SELF.fetch('https://api.test/v1/boards', {
        method: 'POST', headers: dev(), body: JSON.stringify({ name: 'ev-prn', stages: PIPELINE }),
      })).json<{ boardId: string }>();
      await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: dev(), body: JSON.stringify({ title: 't' }) });
      const claim = await (await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
        method: 'POST', headers: as, body: JSON.stringify({ capabilities: ['research'] }),
      })).json<{ runId: string; leaseEpoch: number }>();
      await SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${claim.runId}/complete`, {
        method: 'POST', headers: as, body: JSON.stringify({ leaseEpoch: claim.leaseEpoch, handoff: { summary: 'x' } }),
      });

      let body = await (await evidence(boardId, claim.runId, await hubToken())).json<z.infer<typeof RunEvidence>>();
      expect(RunEvidence.safeParse(body).error).toBeUndefined();
      expect(body.run.agent_principal_id).toBe(AGENT_PRN);
      expect(body.gates[0]).toMatchObject({ produced_by_principal_id: AGENT_PRN, decided_by_principal_id: null });

      await SELF.fetch(`https://api.test/v1/boards/${boardId}/gates/${body.gates[0]!.id}/resolve`, {
        method: 'POST', headers: dev(TENANT, reviewer.id), body: JSON.stringify({ decision: 'reject' }),
      });
      body = await (await evidence(boardId, claim.runId, await hubToken())).json<z.infer<typeof RunEvidence>>();
      expect(body.gates[0]).toMatchObject({
        decision: 'rejected', decided_by: reviewer.id, decided_by_principal_id: USER_PRN, decided_by_hub_sub: null,
      });
    });
  });

  it('a decider linked by a hub auth user id has no principal id here, and is named by decided_by_hub_sub', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { upsertUserByEmail, setUserExternalMapping } = await import('../src/db/catalog');
      const linked = await upsertUserByEmail(env.DB, { email: 'ev-ba-reviewer@example.com' });
      await setUserExternalMapping(env.DB, linked.id, { externalId: 'baSub0000000001', externalSource: 'agentpod' });
      const { boardId, runId } = await aRun({ complete: true });
      const gateId = (await (await evidence(boardId, runId, await hubToken())).json<z.infer<typeof RunEvidence>>()).gates[0]!.id;
      await SELF.fetch(`https://api.test/v1/boards/${boardId}/gates/${gateId}/resolve`, {
        method: 'POST', headers: dev(TENANT, linked.id), body: JSON.stringify({ decision: 'approve' }),
      });
      const body = await (await evidence(boardId, runId, await hubToken())).json<z.infer<typeof RunEvidence>>();
      expect(RunEvidence.safeParse(body).error).toBeUndefined();
      expect(body.gates[0]).toMatchObject({
        decision: 'approved', decided_by: linked.id, decided_by_principal_id: null, decided_by_hub_sub: 'baSub0000000001',
      });
    });
  });

  it('a decider who is an unlinked hub sub is its own decided_by_hub_sub; a plain unlinked usr_ has none', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      for (const [decider, expected] of [['rawHubSub000001', 'rawHubSub000001'], ['usr_nolinkatall', null]] as const) {
        const { boardId, runId } = await aRun({ complete: true });
        const gateId = (await (await evidence(boardId, runId, await hubToken())).json<z.infer<typeof RunEvidence>>()).gates[0]!.id;
        await SELF.fetch(`https://api.test/v1/boards/${boardId}/gates/${gateId}/resolve`, {
          method: 'POST', headers: dev(TENANT, decider), body: JSON.stringify({ decision: 'reject' }),
        });
        const body = await (await evidence(boardId, runId, await hubToken())).json<z.infer<typeof RunEvidence>>();
        expect(body.gates[0]).toMatchObject({ decided_by: decider, decided_by_principal_id: null, decided_by_hub_sub: expected });
      }
    });
  });

  it('a pending gate has neither a decider principal nor a hub sub', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId, runId } = await aRun({ complete: true });
      const body = await (await evidence(boardId, runId, await hubToken())).json<z.infer<typeof RunEvidence>>();
      expect(body.gates[0]).toMatchObject({ status: 'pending', decided_by_principal_id: null, decided_by_hub_sub: null });
    });
  });

  it('an unmapped agent reads as null, never as its agt_ id', async () => {
    await withIssuer(ISSUER, jwksBody, async () => {
      const { boardId, runId } = await aRun(); // claims as the unregistered dev agent `agt_researcher`
      const body = await (await evidence(boardId, runId, await hubToken())).json<z.infer<typeof RunEvidence>>();
      expect(body.run.agent_id).toBe('agt_researcher');
      expect(body.run.agent_principal_id).toBeNull();
    });
  });
});

import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';
import { BoardDO, type BoardInit, type CardView } from '../src/board/board-do';
import { requiredScope, SCOPE_FORBIDDEN } from '../src/auth/scopes';

/**
 * Resume: the human half of a block.
 *
 * A card parked in `input-required` — blocked by its agent, refused twice at its completion check,
 * tripped by the breaker, or refused dispatch — had no way back except dragging it off its stage and
 * back again, which said nothing to the agent that picked it up next. Resume returns it to its stage
 * (or an earlier one) with a comment that is kept on the card's thread AND carried as feedback in
 * the next claim's handoff, and starts the stage's attempt count again.
 */

beforeAll(setupCatalog);

const STAGES: BoardInit['stages'] = [
  { key: 'plan', name: 'Plan', order: 0, ownerKind: 'capability', owner: 'plan' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build', completion: { handoff: ['commit'] } },
  { key: 'review', name: 'Review', order: 2, ownerKind: 'human', gate: 'approval' },
  { key: 'done', name: 'Done', order: 3, ownerKind: 'human' },
];
const PLANNER = { agentId: 'agt_p', capabilities: ['plan'] };
const BUILDER = { agentId: 'agt_b', capabilities: ['build'] };
const PERSON = { id: 'usr_lead', name: 'Lead' };

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function read(b: BoardDO, cardId: string): Promise<CardView> {
  const r = await b.getCardView(cardId);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** A card at `build`, blocked there by its own agent. */
async function blockedAtBuild(b: BoardDO, id: string): Promise<CardView> {
  await b.init({ id, tenantId: 'tnt_resume', name: 'Resume', stages: STAGES });
  const created = await b.createCard({ title: 'Add login', ownerUserId: 'usr_owner' });
  if (!created.ok) throw new Error(created.message);
  const p = await b.claim(PLANNER);
  if (!p.claimed) throw new Error('expected plan claim');
  await b.complete({ runId: p.runId, leaseEpoch: p.leaseEpoch, handoff: { plan: 'use the session table' } });
  const c = await b.claim(BUILDER);
  if (!c.claimed) throw new Error('expected build claim');
  await b.block({ runId: c.runId, leaseEpoch: c.leaseEpoch, reason: 'the staging database is down' });
  return read(b, created.value.id);
}

describe('resuming a parked card', () => {
  it('returns it to its stage as submitted, clears needsHuman, keeps the comment, and carries it to the next claim', async () => {
    await runInDurableObject(stubFor('resume-basic'), async (b: BoardDO) => {
      const card = await blockedAtBuild(b, 'brd_rs1');
      expect(card.needsHuman?.reason).toBe('blocked');

      const r = await b.resumeCard({ cardId: card.id, comment: 'Staging is back — carry on.', actor: PERSON });
      if (!r.ok) throw new Error(r.message);
      expect(r.value.card).toMatchObject({ currentStageKey: 'build', state: 'submitted' });
      expect(r.value.card.needsHuman).toBeUndefined();
      expect(r.value.comment).toMatchObject({ body: 'Staging is back — carry on.', author: { kind: 'human', id: 'usr_lead' } });

      const comments = await b.listComments(card.id);
      if (!comments.ok) throw new Error(comments.message);
      expect(comments.value.map((c) => c.body)).toContain('Staging is back — carry on.');

      const events = await b.getEvents();
      expect(events.find((e) => e.type === 'card.resumed')?.payload).toMatchObject({ cardId: card.id, from: 'build', to: 'build', by: 'usr_lead' });

      const next = await b.claim(BUILDER);
      if (!next.claimed) throw new Error('expected the resumed card to be claimable');
      expect(next.handoff).toMatchObject({ plan: 'use the session table', feedback: 'Staging is back — carry on.' });

      // The run context the bridge reads carries both: the feedback in the handoff, and the comment.
      const ctx = await b.getRunContext({ runId: next.runId, agentId: BUILDER.agentId });
      if (!ctx.ok) throw new Error(ctx.message);
      expect((ctx.value.handoff as { feedback?: string }).feedback).toBe('Staging is back — carry on.');
      expect(ctx.value.comments.map((c) => c.body)).toContain('Staging is back — carry on.');
    });
  });

  it('resets the breaker for the stage — one crash after a resume re-queues rather than parking', async () => {
    await runInDurableObject(stubFor('resume-breaker'), async (b: BoardDO) => {
      await b.init({ id: 'brd_rs2', tenantId: 'tnt_resume', name: 'Resume', stages: STAGES });
      const created = await b.createCard({ title: 'Add login', ownerUserId: 'usr_owner' });
      if (!created.ok) throw new Error(created.message);
      for (let i = 0; i < 2; i++) {
        const c = await b.claim(PLANNER);
        if (!c.claimed) throw new Error('expected claim');
        await b.fail({ runId: c.runId, leaseEpoch: c.leaseEpoch, reason: 'flaky' });
      }
      expect((await read(b, created.value.id)).needsHuman?.reason).toBe('repeated-failure');

      const r = await b.resumeCard({ cardId: created.value.id, comment: 'Fixed the flake.', actor: PERSON });
      expect(r.ok).toBe(true);
      const c = await b.claim(PLANNER);
      if (!c.claimed) throw new Error('expected claim');
      await b.fail({ runId: c.runId, leaseEpoch: c.leaseEpoch, reason: 'flaky again' });
      expect(await read(b, created.value.id)).toMatchObject({ state: 'submitted' });
    });
  });

  it('gives the stage its automatic rework back', async () => {
    await runInDurableObject(stubFor('resume-rework'), async (b: BoardDO) => {
      await b.init({ id: 'brd_rs3', tenantId: 'tnt_resume', name: 'Resume', stages: STAGES.slice(1).map((s, i) => ({ ...s, order: i })) });
      const created = await b.createCard({ title: 'Add login', ownerUserId: 'usr_owner' });
      if (!created.ok) throw new Error(created.message);
      // Refused, reworked, refused: parked.
      for (let i = 0; i < 2; i++) {
        const c = await b.claim(BUILDER);
        if (!c.claimed) throw new Error('expected claim');
        await b.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'done' } });
      }
      expect((await read(b, created.value.id)).state).toBe('input-required');

      await b.resumeCard({ cardId: created.value.id, comment: 'Push it and say the commit.', actor: PERSON });
      const c = await b.claim(BUILDER);
      if (!c.claimed) throw new Error('expected claim');
      await b.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'done' } });
      // A fresh visit: reworked, not parked.
      expect(await read(b, created.value.id)).toMatchObject({ currentStageKey: 'build', state: 'submitted' });
    });
  });

  it('sends it to a named earlier stage', async () => {
    await runInDurableObject(stubFor('resume-earlier'), async (b: BoardDO) => {
      const card = await blockedAtBuild(b, 'brd_rs4');
      const r = await b.resumeCard({ cardId: card.id, toStageKey: 'plan', comment: 'Re-plan without staging.', actor: PERSON });
      if (!r.ok) throw new Error(r.message);
      expect(r.value.card).toMatchObject({ currentStageKey: 'plan', state: 'submitted' });
      const next = await b.claim(PLANNER);
      expect(next.claimed && (next.handoff as { feedback?: string }).feedback).toBe('Re-plan without staging.');
    });
  });

  it('refuses a later stage, an unknown one, an empty comment, and a card that is not waiting', async () => {
    await runInDurableObject(stubFor('resume-refusals'), async (b: BoardDO) => {
      const card = await blockedAtBuild(b, 'brd_rs5');
      const later = await b.resumeCard({ cardId: card.id, toStageKey: 'review', comment: 'skip it', actor: PERSON });
      expect(later).toMatchObject({ ok: false, code: 'INVALID_RESUME' });
      const unknown = await b.resumeCard({ cardId: card.id, toStageKey: 'nope', comment: 'x', actor: PERSON });
      expect(unknown).toMatchObject({ ok: false, code: 'UNKNOWN_STAGE' });
      const empty = await b.resumeCard({ cardId: card.id, comment: '   ', actor: PERSON });
      expect(empty).toMatchObject({ ok: false, code: 'INVALID_COMMENT' });

      await b.resumeCard({ cardId: card.id, comment: 'go', actor: PERSON });
      const again = await b.resumeCard({ cardId: card.id, comment: 'go again', actor: PERSON });
      expect(again).toMatchObject({ ok: false, code: 'CARD_NOT_WAITING' });
      // A refused resume left no comment behind.
      const comments = await b.listComments(card.id);
      expect(comments.ok && comments.value.map((c) => c.body)).toEqual(['go']);
    });
  });

  it('refuses an open question, pointing at the answer instead', async () => {
    await runInDurableObject(stubFor('resume-question'), async (b: BoardDO) => {
      await b.init({ id: 'brd_rs6', tenantId: 'tnt_resume', name: 'Resume', stages: STAGES });
      const created = await b.createCard({ title: 'Add login', ownerUserId: 'usr_owner' });
      if (!created.ok) throw new Error(created.message);
      const c = await b.claim(PLANNER);
      if (!c.claimed) throw new Error('expected claim');
      await b.postActivity({ runId: c.runId, leaseEpoch: c.leaseEpoch, type: 'elicitation', body: 'Which provider?' });
      const r = await b.resumeCard({ cardId: created.value.id, comment: 'Use the default', actor: PERSON });
      expect(r).toMatchObject({ ok: false, code: 'QUESTION_PENDING' });
      expect(!r.ok && r.message).toContain('/answer');
    });
  });

  it('refuses a pending review, pointing at the decision instead', async () => {
    await runInDurableObject(stubFor('resume-review'), async (b: BoardDO) => {
      await b.init({ id: 'brd_rs7', tenantId: 'tnt_resume', name: 'Resume', stages: STAGES });
      const created = await b.createCard({ title: 'Add login', ownerUserId: 'usr_owner' });
      if (!created.ok) throw new Error(created.message);
      const p = await b.claim(PLANNER);
      if (!p.claimed) throw new Error('expected claim');
      await b.complete({ runId: p.runId, leaseEpoch: p.leaseEpoch, handoff: {} });
      const c = await b.claim(BUILDER);
      if (!c.claimed) throw new Error('expected claim');
      await b.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { commit: 'abc123' } });
      expect(await read(b, created.value.id)).toMatchObject({ currentStageKey: 'review', state: 'input-required' });
      const r = await b.resumeCard({ cardId: created.value.id, comment: 'looks fine', actor: PERSON });
      expect(r).toMatchObject({ ok: false, code: 'GATE_PENDING' });
      expect(!r.ok && r.message).toContain('request-changes');
    });
  });

  it('notifies whoever could claim the stage', async () => {
    await runInDurableObject(stubFor('resume-push'), async (b: BoardDO, state) => {
      const card = await blockedAtBuild(b, 'brd_rs8');
      await b.registerPushConfig({ agentId: 'agt_b', url: 'https://hooks.example.com/b', token: 't', capabilities: ['build'] });
      const before = (await b.getPushDeliveries()).length;
      await b.resumeCard({ cardId: card.id, comment: 'go', actor: PERSON });
      const after = await b.getPushDeliveries();
      expect(after.length).toBe(before + 1);
      expect(JSON.parse(after[after.length - 1]!.body)).toMatchObject({ event: 'work.available', cardId: card.id, stageKey: 'build' });
      // The queued delivery would otherwise be sent by the alarm to a host this test does not run.
      await state.storage.deleteAlarm();
    });
  });
});

// ── over HTTP: who may resume ──────────────────────────────────────────────────────────────────

const base = 'https://api.test';
const as = (tenant: string, user: string) => ({ 'X-Tenant-Id': tenant, 'X-User-Id': user, 'Content-Type': 'application/json' });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function members(tenant: string, rows: Array<[string, string]>) {
  for (const [user, role] of rows) {
    await env.DB.prepare(`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, ?)`)
      .bind(`mbr_${tenant}_${user}`, tenant, user, role)
      .run();
  }
}

/** A board with one card its agent has blocked, over the API. */
async function blockedOverHttp(tenant: string) {
  await members(tenant, [['usr_owner', 'owner'], ['usr_m', 'member'], ['usr_v', 'viewer']]);
  const created = await SELF.fetch(`${base}/v1/boards`, {
    method: 'POST', headers: as(tenant, 'usr_owner'),
    body: JSON.stringify({ name: 'R', stages: [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }] }),
  });
  const boardId = (await created.json<{ boardId: string }>()).boardId;
  const cardRes = await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, { method: 'POST', headers: as(tenant, 'usr_owner'), body: JSON.stringify({ title: 'x' }) });
  const cardId = (await cardRes.json<{ card: { id: string } }>()).card.id;
  const agent = await createAgent(env.DB, tenant, { name: 'Builder', capabilities: ['build'] });
  const { token } = await createAgentToken(env.DB, tenant, agent.id, ['read', 'queue', 'plan', 'claim', 'run']);
  const claim = await (await SELF.fetch(`${base}/v1/boards/${boardId}/claims`, { method: 'POST', headers: bearer(token), body: '{}' }))
    .json<{ runId: string; leaseEpoch: number }>();
  const blocked = await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${claim.runId}/block`, {
    method: 'POST', headers: bearer(token), body: JSON.stringify({ leaseEpoch: claim.leaseEpoch, reason: 'stuck' }),
  });
  expect(blocked.status).toBe(200);
  return { boardId, cardId, token };
}

const resume = (boardId: string, cardId: string, headers: Record<string, string>, body: unknown) =>
  SELF.fetch(`${base}/v1/boards/${boardId}/cards/${cardId}/resume`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('POST /v1/boards/:id/cards/:cardId/resume', () => {
  it('lets a member resume, as themselves', async () => {
    const { boardId, cardId } = await blockedOverHttp('tnt_resume_member');
    const res = await resume(boardId, cardId, as('tnt_resume_member', 'usr_m'), { comment: 'go on' });
    expect(res.status).toBe(200);
    const body = await res.json<{ card: { state: string }; comment: { author: { id: string } } }>();
    expect(body.card.state).toBe('submitted');
    expect(body.comment.author.id).toBe('usr_m');
  });

  it('refuses a viewer and a non-member (403) — resuming is moving the card', async () => {
    const t = 'tnt_resume_roles';
    const { boardId, cardId } = await blockedOverHttp(t);
    expect((await resume(boardId, cardId, as(t, 'usr_v'), { comment: 'go' })).status).toBe(403);
    expect((await resume(boardId, cardId, as(t, 'usr_stranger'), { comment: 'go' })).status).toBe(403);
  });

  it('refuses an agent (403), whatever scopes its token holds — resuming is the human half of a block', async () => {
    const t = 'tnt_resume_agent';
    const { boardId, cardId, token } = await blockedOverHttp(t);
    expect((await resume(boardId, cardId, bearer(token), { comment: 'I unblocked myself' })).status).toBe(403);
  });

  it('answers 400 for a missing comment, 409 for a card not waiting, 404 for an unknown card', async () => {
    const t = 'tnt_resume_shape';
    const { boardId, cardId } = await blockedOverHttp(t);
    expect((await resume(boardId, cardId, as(t, 'usr_m'), {})).status).toBe(400);
    expect((await resume(boardId, 'crd_nope', as(t, 'usr_m'), { comment: 'x' })).status).toBe(404);
    expect((await resume(boardId, cardId, as(t, 'usr_m'), { comment: 'x' })).status).toBe(200);
    expect((await resume(boardId, cardId, as(t, 'usr_m'), { comment: 'x' })).status).toBe(409);
  });
});

describe('the resume route, by scope', () => {
  it('is forbidden on every agent scope — the route check, not only the handler, refuses it', () => {
    expect(requiredScope('cards/crd_x/resume', 'POST')).toBe(SCOPE_FORBIDDEN);
  });
});

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit, type CardView } from '../src/board/board-do';

/**
 * One automatic rework when a run's handoff fails its stage's completion requirement.
 *
 * Before this, the first refusal parked the card for a person at once. Most refusals are an agent
 * forgetting one field it could have produced, and a person then had to read the refusal, type the
 * same sentence back as feedback, and requeue the card. The board now does that once, itself: the
 * card goes back to `submitted` on the same stage with feedback naming exactly what was missing,
 * and only a second refusal on the same card and stage parks it.
 */

const STAGES: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research', completion: { handoff: ['alternatives'] } },
  { key: 'decide', name: 'Decide', order: 1, ownerKind: 'capability', owner: 'decide' },
];

const GATED: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research', completion: { handoff: ['alternatives'] } },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'decide', name: 'Decide', order: 2, ownerKind: 'capability', owner: 'decide' },
];

const RESEARCHER = { agentId: 'agt_r', capabilities: ['research'] };

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function setup(b: BoardDO, id: string, stages = STAGES): Promise<CardView> {
  await b.init({ id, tenantId: 'tnt_rework', name: 'Rework', stages });
  const r = await b.createCard({ title: 'Pick a database', ownerUserId: 'usr_owner' });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

async function claim(b: BoardDO) {
  const c = await b.claim(RESEARCHER);
  if (!c.claimed) throw new Error('expected a claim');
  return c;
}

async function read(b: BoardDO, cardId: string): Promise<CardView> {
  const r = await b.getCardView(cardId);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe('a failed completion check gets one automatic rework', () => {
  it('the first refusal returns the card to the same stage, claimable, with feedback naming what was missing', async () => {
    await runInDurableObject(stubFor('rework-first'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_rw1');
      const c = await claim(b);
      const res = await b.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'Postgres.' } });
      expect(res.ok).toBe(true);

      const got = await read(b, card.id);
      expect(got).toMatchObject({ currentStageKey: 'research', state: 'submitted' });
      // Not waiting on anybody: the board is handling this one itself.
      expect(got.needsHuman).toBeUndefined();

      // The run still says what it was: blocked, not completed.
      const attempts = await b.getAttempts(card.id);
      expect(attempts.find((a) => a.runId === c.runId)?.outcome).toBe('blocked');

      const events = await b.getEvents();
      const ev = events.find((e) => e.type === 'card.rework_requested');
      expect(ev?.payload).toMatchObject({ cardId: card.id, stageKey: 'research', runId: c.runId });
      expect(String((ev?.payload as { reason?: string }).reason)).toContain('alternatives');

      const notes = await b.getNotifications();
      expect(notes.some((n) => n.kind === 'rework' && n.cardId === card.id && n.body.includes('alternatives'))).toBe(true);
    });
  });

  it("the next claim's prompt carries the feedback and the refused handoff, and the run context does too", async () => {
    await runInDurableObject(stubFor('rework-carries'), async (b: BoardDO) => {
      await setup(b, 'brd_rw2');
      const c1 = await claim(b);
      await b.complete({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, handoff: { summary: 'Postgres.' } });

      const c2 = await claim(b);
      const handoff = c2.handoff as { feedback?: string; refusedHandoff?: unknown };
      expect(handoff.feedback).toContain('Your handoff was refused');
      expect(handoff.feedback).toContain('alternatives');
      expect(handoff.refusedHandoff).toEqual({ summary: 'Postgres.' });

      // The bridge reads GET /runs/:runId — the same feedback must be there.
      const ctx = await b.getRunContext({ runId: c2.runId, agentId: RESEARCHER.agentId });
      if (!ctx.ok) throw new Error(ctx.message);
      expect((ctx.value.handoff as { feedback?: string }).feedback).toContain('alternatives');
    });
  });

  it('keeps the input the stage was given, so the rework is not starved of its brief', async () => {
    await runInDurableObject(stubFor('rework-keeps-input'), async (b: BoardDO) => {
      await b.init({
        id: 'brd_rw3', tenantId: 'tnt_rework', name: 'Rework',
        stages: [
          { key: 'brief', name: 'Brief', order: 0, ownerKind: 'capability', owner: 'brief' },
          ...STAGES.map((s) => ({ ...s, order: s.order + 1 })),
        ],
      });
      await b.createCard({ title: 'Pick a database', ownerUserId: 'usr_owner' });
      const brief = await b.claim({ agentId: 'agt_b', capabilities: ['brief'] });
      if (!brief.claimed) throw new Error('expected a claim');
      await b.complete({ runId: brief.runId, leaseEpoch: brief.leaseEpoch, handoff: { question: 'Which database?' } });

      const c1 = await claim(b);
      await b.complete({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, handoff: { summary: 'Postgres.' } });
      const c2 = await claim(b);
      expect(c2.handoff).toMatchObject({ question: 'Which database?' });
    });
  });

  it('a second refusal on the same card and stage parks it for a person, naming both refusals', async () => {
    await runInDurableObject(stubFor('rework-second'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_rw4');
      const c1 = await claim(b);
      await b.complete({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, handoff: { summary: 'Postgres.' } });
      const c2 = await claim(b);
      await b.complete({ runId: c2.runId, leaseEpoch: c2.leaseEpoch, handoff: 'Postgres, honestly.' });

      const got = await read(b, card.id);
      expect(got).toMatchObject({ currentStageKey: 'research', state: 'input-required' });
      expect(got.needsHuman?.reason).toBe('blocked');
      // Both: what the first attempt left out, and what the rework still got wrong.
      expect(got.needsHuman?.detail).toContain('the handoff is missing alternatives');
      expect(got.needsHuman?.detail).toContain('got string');
      // Parked, not handed out a third time.
      expect((await b.claim(RESEARCHER)).claimed).toBe(false);
    });
  });

  it('a rework that succeeds advances exactly as a first-time success would, and clears the count', async () => {
    await runInDurableObject(stubFor('rework-succeeds'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_rw5');
      const c1 = await claim(b);
      await b.complete({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, handoff: { summary: 'Postgres.' } });
      const c2 = await claim(b);
      await b.complete({ runId: c2.runId, leaseEpoch: c2.leaseEpoch, handoff: { summary: 'Postgres.', alternatives: ['SQLite'] } });

      const got = await read(b, card.id);
      expect(got).toMatchObject({ currentStageKey: 'decide', state: 'submitted' });
    });
  });

  it('cannot loop with the circuit breaker: a refusal after a crash parks rather than reworking', async () => {
    await runInDurableObject(stubFor('rework-breaker'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_rw6');
      const c1 = await claim(b);
      await b.fail({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, reason: 'the API timed out' });
      const c2 = await claim(b);
      await b.complete({ runId: c2.runId, leaseEpoch: c2.leaseEpoch, handoff: { summary: 'Postgres.' } });

      // Two failed attempts is the breaker's limit, and a rework is an attempt.
      const got = await read(b, card.id);
      expect(got.state).toBe('input-required');
      expect(got.needsHuman?.reason).toBe('repeated-failure');
      expect(got.needsHuman?.detail).toContain('alternatives');
      expect((await b.claim(RESEARCHER)).claimed).toBe(false);
    });
  });

  it('a crash after the rework trips the breaker too — the rework did not reset it', async () => {
    await runInDurableObject(stubFor('rework-then-crash'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_rw7');
      const c1 = await claim(b);
      await b.complete({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, handoff: { summary: 'Postgres.' } });
      const c2 = await claim(b);
      await b.fail({ runId: c2.runId, leaseEpoch: c2.leaseEpoch, reason: 'out of memory' });
      const got = await read(b, card.id);
      expect(got.state).toBe('input-required');
      expect(got.needsHuman?.reason).toBe('repeated-failure');
    });
  });

  it('a reviewer asking for changes is a fresh visit to the stage, with a fresh rework', async () => {
    await runInDurableObject(stubFor('rework-gate'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_rw8', GATED);
      const c1 = await claim(b);
      await b.complete({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, handoff: { summary: 'Postgres.' } });
      const c2 = await claim(b);
      await b.complete({ runId: c2.runId, leaseEpoch: c2.leaseEpoch, handoff: { summary: 'Postgres.', alternatives: ['SQLite'] } });
      expect((await read(b, card.id)).currentStageKey).toBe('review');

      const gate = (await b.getState()).gates.find((g) => g.cardId === card.id);
      if (!gate) throw new Error('expected a pending gate');
      await b.resolveGate({ gateId: gate.id, decision: 'request_changes', decidedBy: 'usr_reviewer', comment: 'Add MySQL' });

      const c3 = await claim(b);
      await b.complete({ runId: c3.runId, leaseEpoch: c3.leaseEpoch, handoff: { summary: 'Postgres again.' } });
      // The earlier rework was spent on an earlier visit; this one is owed its own.
      expect(await read(b, card.id)).toMatchObject({ currentStageKey: 'research', state: 'submitted' });
    });
  });
});

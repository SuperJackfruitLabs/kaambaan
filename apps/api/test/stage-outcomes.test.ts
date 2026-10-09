import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit, type CardView } from '../src/board/board-do';

/**
 * A finished turn says what KIND of finish it is (`StageOutcome` in @superpipeline/contract).
 *
 * Two live failures on 2026-10-09, one missing word:
 *  - an `integrate` run handed off `verdict: "unsafe — do not ship"` and the card advanced to its
 *    sign-off gate anyway, because `complete` meant "advance" whatever the handoff said;
 *  - an agent that needed a person to approve a device sign-in ended its turn with the link, and
 *    the board read it as a broken handoff, refused it twice and parked the card as one.
 */

const PIPELINE: BoardInit['stages'] = [
  { key: 'fix', name: 'Fix', order: 0, ownerKind: 'capability', owner: 'fix' },
  {
    key: 'integrate',
    name: 'Integrate',
    order: 1,
    ownerKind: 'capability',
    owner: 'integrate',
    returnStage: 'fix',
    completion: { handoff: ['verdict'] },
  },
  { key: 'signed-off', name: 'Signed off', order: 2, ownerKind: 'human', gate: 'approval' },
  { key: 'done', name: 'Done', order: 3, ownerKind: 'human' },
];

/** The same board before this existed: `integrate` declares no return stage. */
const UNCONFIGURED: BoardInit['stages'] = PIPELINE.map((s) => {
  const { returnStage: _ignored, ...rest } = s;
  return rest;
});

const FIXER = { agentId: 'agt_fix', capabilities: ['fix'] };
const JUDGE = { agentId: 'agt_judge', capabilities: ['integrate'] };

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function setup(b: BoardDO, id: string, stages = PIPELINE): Promise<CardView> {
  await b.init({ id, tenantId: 'tnt_outcome', name: 'Outcomes', stages });
  const r = await b.createCard({ title: 'Ship the migration', ownerUserId: 'usr_owner' });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

async function claim(b: BoardDO, who: { agentId: string; capabilities: string[] }) {
  const c = await b.claim(who);
  if (!c.claimed) throw new Error(`expected ${who.agentId} to claim`);
  return c;
}

async function read(b: BoardDO, cardId: string): Promise<CardView> {
  const r = await b.getCardView(cardId);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** Work `fix` and hand the card to `integrate`, returning the judge's claim. */
async function toIntegrate(b: BoardDO) {
  const f = await claim(b, FIXER);
  const done = await b.complete({ runId: f.runId, leaseEpoch: f.leaseEpoch, agentId: FIXER.agentId, handoff: { summary: 'fixed' } });
  if (!done.ok) throw new Error(done.message);
  return claim(b, JUDGE);
}

const FINDINGS = 'The migration drops `users.legacy_id`, which the export job still reads.';

describe('a failing verdict sends the card back', () => {
  it('changes-needed returns the card to the declared stage — it does not advance', async () => {
    await runInDurableObject(stubFor('outcome-return'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_out1');
      const j = await toIntegrate(b);
      const res = await b.complete({
        runId: j.runId,
        leaseEpoch: j.leaseEpoch,
        agentId: JUDGE.agentId,
        handoff: { verdict: 'unsafe — do not ship' },
        outcome: 'changes-needed',
        findings: FINDINGS,
      });
      expect(res.ok).toBe(true);

      const got = await read(b, card.id);
      expect(got).toMatchObject({ currentStageKey: 'fix', state: 'submitted' });
      expect(got.needsHuman).toBeUndefined();

      // The judge's run did its job: it completed. What it found is the card's business.
      const attempts = await b.getAttempts(card.id);
      expect(attempts.find((a) => a.runId === j.runId)?.outcome).toBe('completed');

      // The findings are on the thread, where people read, attributed to the judge.
      const comments = await b.listComments(card.id);
      if (!comments.ok) throw new Error(comments.message);
      expect(comments.value.some((c) => c.body.includes(FINDINGS) && c.author.kind === 'agent' && c.author.id === JUDGE.agentId)).toBe(true);

      const events = await b.getEvents();
      expect(events.find((e) => e.type === 'card.returned')?.payload).toMatchObject({ cardId: card.id, from: 'integrate', to: 'fix' });
    });
  });

  it('the fixer is handed the findings as feedback, and the judge’s handoff beside them', async () => {
    await runInDurableObject(stubFor('outcome-handoff'), async (b: BoardDO) => {
      await setup(b, 'brd_out2');
      const j = await toIntegrate(b);
      await b.complete({
        runId: j.runId,
        leaseEpoch: j.leaseEpoch,
        agentId: JUDGE.agentId,
        handoff: { verdict: 'unsafe' },
        outcome: 'changes-needed',
        findings: FINDINGS,
      });
      const f = await claim(b, FIXER);
      const h = f.handoff as { feedback?: string; findings?: string; returnedFrom?: string; verdict?: string };
      expect(h.feedback).toContain(FINDINGS);
      expect(h.findings).toBe(FINDINGS);
      expect(h.returnedFrom).toBe('integrate');
      expect(h.verdict).toBe('unsafe');
    });
  });

  it('a pass advances exactly as complete always did', async () => {
    await runInDurableObject(stubFor('outcome-pass'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_out3');
      const j = await toIntegrate(b);
      await b.complete({ runId: j.runId, leaseEpoch: j.leaseEpoch, agentId: JUDGE.agentId, handoff: { verdict: 'safe' }, outcome: 'pass' });
      expect((await read(b, card.id)).currentStageKey).toBe('signed-off');
    });
  });

  it('a judging stage that says nothing has not passed: the completion is refused, not advanced', async () => {
    await runInDurableObject(stubFor('outcome-silent'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_out4');
      const j = await toIntegrate(b);
      await b.complete({ runId: j.runId, leaseEpoch: j.leaseEpoch, agentId: JUDGE.agentId, handoff: { verdict: 'unsafe' } });
      const got = await read(b, card.id);
      // The stage's one automatic rework, naming what to add.
      expect(got).toMatchObject({ currentStageKey: 'integrate', state: 'submitted' });
      const again = await claim(b, JUDGE);
      expect((again.handoff as { feedback?: string }).feedback).toMatch(/changes-needed/);
    });
  });

  it('changes-needed on a stage that declares no return stage parks for a person — never advances', async () => {
    await runInDurableObject(stubFor('outcome-unconfigured'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_out5', UNCONFIGURED);
      const j = await toIntegrate(b);
      await b.complete({
        runId: j.runId,
        leaseEpoch: j.leaseEpoch,
        agentId: JUDGE.agentId,
        handoff: { verdict: 'unsafe' },
        outcome: 'changes-needed',
        findings: FINDINGS,
      });
      const got = await read(b, card.id);
      expect(got).toMatchObject({ currentStageKey: 'integrate', state: 'input-required' });
      expect(got.needsHuman?.reason).toBe('blocked');
      expect(got.needsHuman?.detail).toContain(FINDINGS);
    });
  });

  it('a board that never says an outcome behaves exactly as before', async () => {
    await runInDurableObject(stubFor('outcome-backcompat'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_out6', UNCONFIGURED);
      const j = await toIntegrate(b);
      await b.complete({ runId: j.runId, leaseEpoch: j.leaseEpoch, agentId: JUDGE.agentId, handoff: { verdict: 'unsafe' } });
      expect((await read(b, card.id)).currentStageKey).toBe('signed-off');
    });
  });

  it('a malformed outcome is an error on the same run, which stays live to correct it', async () => {
    await runInDurableObject(stubFor('outcome-malformed'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_out7');
      const j = await toIntegrate(b);
      const res = await b.complete({ runId: j.runId, leaseEpoch: j.leaseEpoch, agentId: JUDGE.agentId, handoff: { verdict: 'x' }, outcome: 'changes-needed' });
      expect(res.ok).toBe(false);
      expect(!res.ok && res.code).toBe('INVALID_OUTCOME');
      expect(await read(b, card.id)).toMatchObject({ currentStageKey: 'integrate', state: 'working', currentRunId: j.runId });
    });
  });
});

describe('the automatic returns are bounded', () => {
  async function failOnce(b: BoardDO): Promise<void> {
    const j = await toIntegrate(b);
    await b.complete({
      runId: j.runId,
      leaseEpoch: j.leaseEpoch,
      agentId: JUDGE.agentId,
      handoff: { verdict: 'unsafe' },
      outcome: 'changes-needed',
      findings: FINDINGS,
    });
  }

  it('past the limit the card parks for a person instead of looping fix → integrate forever', async () => {
    await runInDurableObject(stubFor('outcome-cap'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_cap1');
      await failOnce(b);
      expect((await read(b, card.id)).currentStageKey).toBe('fix');
      await failOnce(b);
      expect((await read(b, card.id)).currentStageKey).toBe('fix');
      await failOnce(b);

      const got = await read(b, card.id);
      expect(got).toMatchObject({ currentStageKey: 'integrate', state: 'input-required' });
      expect(got.needsHuman?.reason).toBe('repeated-failure');
      expect(got.needsHuman?.detail).toContain(FINDINGS);
      expect((await b.claim(FIXER)).claimed).toBe(false);
      expect((await b.claim(JUDGE)).claimed).toBe(false);
    });
  });

  it('a person resuming the card gives it its returns back', async () => {
    await runInDurableObject(stubFor('outcome-cap-reset'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_cap2');
      await failOnce(b);
      await failOnce(b);
      await failOnce(b);
      const resumed = await b.resumeCard({ cardId: card.id, comment: 'Kept the column; try again.', toStageKey: 'fix', actor: { id: 'usr_owner', name: 'Owner' } });
      expect(resumed.ok).toBe(true);
      await failOnce(b);
      expect((await read(b, card.id))).toMatchObject({ currentStageKey: 'fix', state: 'submitted' });
    });
  });
});

describe('a person moving the card also gives it its returns back', () => {
  it('moveCard resets the count', async () => {
    await runInDurableObject(stubFor('outcome-cap-move'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_cap3');
      for (let i = 0; i < 3; i++) {
        const j = await toIntegrate(b);
        await b.complete({ runId: j.runId, leaseEpoch: j.leaseEpoch, agentId: JUDGE.agentId, handoff: { verdict: 'unsafe' }, outcome: 'changes-needed', findings: FINDINGS });
      }
      expect((await read(b, card.id)).state).toBe('input-required');
      const moved = await b.moveCard(card.id, 'fix', 'usr_owner');
      expect(moved.ok).toBe(true);
      const j = await toIntegrate(b);
      await b.complete({ runId: j.runId, leaseEpoch: j.leaseEpoch, agentId: JUDGE.agentId, handoff: { verdict: 'unsafe' }, outcome: 'changes-needed', findings: FINDINGS });
      expect(await read(b, card.id)).toMatchObject({ currentStageKey: 'fix', state: 'submitted' });
    });
  });
});

describe('needs-person parks the card on a question', () => {
  const QUESTION = 'Approve the device sign-in for the deploy account, then answer done.';
  const URL = 'https://login.example.test/device?code=WXYZ';

  async function park(b: BoardDO) {
    const j = await toIntegrate(b);
    const res = await b.complete({
      runId: j.runId,
      leaseEpoch: j.leaseEpoch,
      agentId: JUDGE.agentId,
      // Deliberately missing the stage's required `verdict`: the run is not finished, so the
      // completion check does not apply to it.
      handoff: { progress: 'built and staged; deploy needs the sign-in' },
      outcome: 'needs-person',
      question: QUESTION,
      url: URL,
    });
    if (!res.ok) throw new Error(res.message);
    return j;
  }

  it('parks on a pending question carrying the link — not a refused handoff', async () => {
    await runInDurableObject(stubFor('outcome-park'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_np1');
      const j = await park(b);

      const got = await read(b, card.id);
      expect(got).toMatchObject({ currentStageKey: 'integrate', state: 'input-required', currentRunId: null });
      expect(got.needsHuman?.reason).toBe('question');

      const pending = (await b.getState()).elicitations;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ id: got.needsHuman?.elicitationId, cardId: card.id, runId: j.runId, status: 'pending' });
      expect(pending[0]!.question).toContain(QUESTION);
      expect(pending[0]!.question).toContain(URL);

      // Reaches the projection the chat rooms are fed from.
      const deliveries = await b.pendingElicitationDeliveries();
      expect(deliveries.some((d) => JSON.stringify(d).includes(URL))).toBe(true);

      // Agent-authored, so a bridge that finds the run ended knows the agent reported.
      const attempts = await b.getAttempts(card.id);
      expect(attempts.find((a) => a.runId === j.runId)?.outcome).toBe('blocked');
      // No refusal was recorded: nothing was checked, because nothing was claimed finished.
      expect((await b.getEvents()).some((e) => e.type === 'card.rework_requested')).toBe(false);
    });
  });

  it('answering it re-queues the same stage with the answer and the work so far, and costs no attempt', async () => {
    await runInDurableObject(stubFor('outcome-resume'), async (b: BoardDO) => {
      const card = await setup(b, 'brd_np2');
      await park(b);
      const elicitationId = (await read(b, card.id)).needsHuman!.elicitationId!;
      const answered = await b.answerElicitation({ elicitationId, answeredBy: 'usr_owner', text: 'done' });
      expect(answered.ok).toBe(true);

      const got = await read(b, card.id);
      expect(got).toMatchObject({ currentStageKey: 'integrate', state: 'submitted' });
      expect(got.needsHuman).toBeUndefined();

      const again = await claim(b, JUDGE);
      const h = again.handoff as {
        feedback?: string;
        resumed?: { question?: string; answer?: { text?: string | null }; workSoFar?: unknown };
        summary?: string;
      };
      expect(h.feedback).toContain(QUESTION);
      expect(h.feedback).toContain('done');
      expect(h.resumed?.answer?.text).toBe('done');
      expect(h.resumed?.workSoFar).toEqual({ progress: 'built and staged; deploy needs the sign-in' });
      // The stage's own input is still there: the work continues, it does not start from nothing.
      expect(h.summary).toBe('fixed');

      // The pause was not a failure: the stage still owes its one automatic rework.
      await b.complete({ runId: again.runId, leaseEpoch: again.leaseEpoch, agentId: JUDGE.agentId, handoff: { nothing: 1 }, outcome: 'pass' });
      expect(await read(b, card.id)).toMatchObject({ currentStageKey: 'integrate', state: 'submitted' });
    });
  });

  it('needs a question', async () => {
    await runInDurableObject(stubFor('outcome-park-noq'), async (b: BoardDO) => {
      await setup(b, 'brd_np3');
      const j = await toIntegrate(b);
      const res = await b.complete({ runId: j.runId, leaseEpoch: j.leaseEpoch, agentId: JUDGE.agentId, outcome: 'needs-person' });
      expect(!res.ok && res.code).toBe('INVALID_OUTCOME');
    });
  });
});

describe('a return stage is validated where it is written', () => {
  it('refuses a return stage that is not an earlier stage, on both writes', async () => {
    await runInDurableObject(stubFor('outcome-validate'), async (b: BoardDO) => {
      await b.init({ id: 'brd_val', tenantId: 'tnt_outcome', name: 'V', stages: UNCONFIGURED });
      const later = await b.updateStage('integrate', { returnStage: 'done' });
      expect(!later.ok && later.code).toBe('INVALID_STAGES');
      const missing = await b.updateStage('integrate', { returnStage: 'fxi' });
      expect(!missing.ok && missing.code).toBe('INVALID_STAGES');
      const good = await b.updateStage('integrate', { returnStage: 'fix' });
      expect(good.ok && good.value.stage.returnStage).toBe('fix');
      const cleared = await b.updateStage('integrate', { returnStage: null });
      expect(cleared.ok && cleared.value.stage.returnStage).toBeUndefined();

      const replace = await b.setStages(PIPELINE.map((s) => (s.key === 'integrate' ? { ...s, returnStage: 'integrate' } : s)));
      expect(!replace.ok && replace.code).toBe('INVALID_STAGES');
      // Removing the stage another one returns to is refused too, rather than leaving a dangling return.
      const orphan = await b.setStages(PIPELINE.filter((s) => s.key !== 'fix').map((s, i) => ({ ...s, order: i })));
      expect(!orphan.ok && orphan.code).toBe('INVALID_STAGES');
    });
  });
});

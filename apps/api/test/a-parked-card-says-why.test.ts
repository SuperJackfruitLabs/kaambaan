import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit, type CardView } from '../src/board/board-do';

/**
 * Why a card needs a human.
 *
 * `input-required` means two different things and the card cannot tell them apart:
 *
 *  - an agent stopped to ASK something, and there is a question to answer;
 *  - the card failed twice and `endAttempt` tripped the circuit breaker, parking it
 *    for a person — with no question, and nothing to answer.
 *
 * Observed on card `a9619fe` (Client Quality, 2026-10-03): state `input-required`,
 * zero pending elicitations on the board, a handoff reading "Verification is in
 * progress", and nothing anywhere saying why. To a person it reads as a card
 * demanding input that offers nothing to input — a dead end.
 *
 * The information already exists: `endAttempt` emits `brokeCircuit`. It is simply
 * thrown away before it reaches the card. This is the card keeping it.
 */

const PIPELINE: BoardInit['stages'] = [
  { key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'code' },
  { key: 'verify', name: 'Verify', order: 1, ownerKind: 'capability', owner: 'test' },
];

const CODER = { agentId: 'agt_c', capabilities: ['code'] };

const OPTIONS = [
  { name: 'run_them', title: 'Run the tests' },
  { name: 'skip', title: 'Skip them' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function board(name: string, id: string): Promise<DurableObjectStub<BoardDO>> {
  const stub = stubFor(name);
  await runInDurableObject(stub, async (b: BoardDO) => {
    await b.init({ id, tenantId: 'tnt_a', name: 'Parked', stages: PIPELINE });
  });
  return stub;
}

async function mustCreate(b: BoardDO, title = 'Improve the homepage'): Promise<CardView> {
  const r = await b.createCard({ title, ownerUserId: 'usr_a' });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** One card, through the public surface — `getCard` is private to the DO. */
async function read(b: BoardDO, cardId: string): Promise<CardView> {
  const r = await b.getCardView(cardId);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** Claim and fail, as an agent whose run went wrong does. */
async function claimAndFail(b: BoardDO, reason: string): Promise<void> {
  const c = await b.claim(CODER);
  if (!c.claimed) throw new Error('expected a claim');
  await b.fail({ runId: c.runId, leaseEpoch: c.leaseEpoch, reason });
}

describe('a card parked by the circuit breaker says so', () => {
  it('does not claim to need a human before the breaker trips', async () => {
    // One failure re-queues; the card is `submitted` and nobody is waiting on anyone.
    await runInDurableObject(await board('park-one', 'brd_p1'), async (b: BoardDO) => {
      const card = await mustCreate(b);
      await claimAndFail(b, 'first failure');

      const got = await read(b, card.id);
      expect(got.state).toBe('submitted');
      expect(got.needsHuman).toBeUndefined();
    });
  });

  it('names repeated failure, and carries the reason the run gave', async () => {
    // "Needs you" with no reason sends a person to read the activity log to find out
    // whether anything is even wrong. The run already said why it failed.
    await runInDurableObject(await board('park-two', 'brd_p2'), async (b: BoardDO) => {
      const card = await mustCreate(b);
      await claimAndFail(b, 'first failure');
      await claimAndFail(b, 'verification never finished');

      const got = await read(b, card.id);
      expect(got.state).toBe('input-required');
      expect(got.needsHuman?.reason).toBe('repeated-failure');
      expect(got.needsHuman?.detail).toContain('verification never finished');
      expect(got.needsHuman?.failureCount).toBe(2);
    });
  });

  it('names a question, and which one, when an agent asked', async () => {
    await runInDurableObject(await board('park-ask', 'brd_p3'), async (b: BoardDO) => {
      const card = await mustCreate(b);
      const c = await b.claim(CODER);
      if (!c.claimed) throw new Error('expected a claim');
      await b.postActivity({
        runId: c.runId,
        leaseEpoch: c.leaseEpoch,
        agentId: CODER.agentId,
        type: 'elicitation',
        body: 'May I run the test suite?',
        signal: 'select',
        parameter: { options: OPTIONS } as never,
      });

      const got = await read(b, card.id);
      expect(got.state).toBe('input-required');
      expect(got.needsHuman?.reason).toBe('question');
      expect(got.needsHuman?.elicitationId).toMatch(/^elc_/);
    });
  });

  it('stops saying it once the question is answered', async () => {
    await runInDurableObject(await board('park-answered', 'brd_p4'), async (b: BoardDO) => {
      const card = await mustCreate(b);
      const c = await b.claim(CODER);
      if (!c.claimed) throw new Error('expected a claim');
      await b.postActivity({
        runId: c.runId,
        leaseEpoch: c.leaseEpoch,
        agentId: CODER.agentId,
        type: 'elicitation',
        body: 'May I run the test suite?',
        signal: 'select',
        parameter: { options: OPTIONS } as never,
      });
      const asked = (await read(b, card.id)).needsHuman!.elicitationId!;

      const answered = await b.answerElicitation({ elicitationId: asked, answeredBy: 'usr_h', option: 'skip' });
      expect(answered.ok).toBe(true);

      const got = await read(b, card.id);
      expect(got.state).toBe('working');
      expect(got.needsHuman).toBeUndefined();
    });
  });

  it('stops saying it when a person moves the card', async () => {
    // A move is a person taking the card somewhere on purpose. Carrying "needs you"
    // across that would make the board ask for something already given.
    await runInDurableObject(await board('park-moved', 'brd_p5'), async (b: BoardDO) => {
      const card = await mustCreate(b);
      await claimAndFail(b, 'first failure');
      await claimAndFail(b, 'second failure');
      expect((await read(b, card.id)).needsHuman).toBeDefined();

      const moved = await b.moveCard(card.id, 'verify', 'usr_h');
      expect(moved.ok).toBe(true);

      expect((await read(b, card.id)).needsHuman).toBeUndefined();
    });
  });

  it('is not claimable again until a person moves it', async () => {
    // What makes the breaker a brake. Claiming selects `state = 'submitted'`, and a
    // parked card is `input-required`, so no agent can pick it up and burn another
    // attempt on the same untrue claim. The human move is the reset — which is why
    // the move is also what clears the reason.
    await runInDurableObject(await board('park-reclaimed', 'brd_p6'), async (b: BoardDO) => {
      const card = await mustCreate(b);
      await claimAndFail(b, 'first failure');
      await claimAndFail(b, 'second failure');

      const again = await b.claim(CODER);
      expect(again.claimed).toBe(false);
      expect((await read(b, card.id)).needsHuman?.reason).toBe('repeated-failure');

      const moved = await b.moveCard(card.id, 'verify', 'usr_h');
      expect(moved.ok).toBe(true);
      const after = await read(b, card.id);
      expect(after.state).toBe('submitted');
      expect(after.needsHuman).toBeUndefined();
    });
  });

  it('replaces a question with the failure when the run then fails', async () => {
    // The last reason wins rather than the first: a card that asked, went unanswered
    // and then failed is waiting on a person for the FAILURE now, and pointing at a
    // cancelled question would send them somewhere with nothing to do.
    await runInDurableObject(await board('park-both', 'brd_p7'), async (b: BoardDO) => {
      const card = await mustCreate(b);
      await claimAndFail(b, 'first failure');

      const c = await b.claim(CODER);
      if (!c.claimed) throw new Error('expected a claim');
      await b.postActivity({
        runId: c.runId,
        leaseEpoch: c.leaseEpoch,
        agentId: CODER.agentId,
        type: 'elicitation',
        body: 'May I?',
        signal: 'select',
        parameter: { options: OPTIONS } as never,
      });
      expect((await read(b, card.id)).needsHuman?.reason).toBe('question');

      await b.fail({ runId: c.runId, leaseEpoch: c.leaseEpoch, reason: 'gave up waiting' });

      const got = await read(b, card.id);
      expect(got.needsHuman?.reason).toBe('repeated-failure');
      expect(got.needsHuman?.detail).toContain('gave up waiting');
    });
  });
});

/**
 * Every way a card comes to rest on a person, not just the two I shipped.
 *
 * Found in production on 2026-10-03. A verify agent asked permission, got no answer
 * (delivery was broken), and blocked its own run. `block()` cancels the run's pending
 * questions — so the question was gone, and the card went on reporting
 *
 *     needsHuman: { reason: "question", elicitationId: "elc_51635924cfa34d8a" }
 *
 * pointing at a question that no longer existed, while saying nothing about the block
 * that was the actual reason it stopped. That is the exact failure the first commit
 * named: "a stale 'needs you' is worse than none — it sends somebody to a card that
 * wants nothing."
 *
 * Five places write `state = 'input-required'`. The rule is that every one of them says
 * why, because a card that stops without a reason is a card somebody has to reverse
 * engineer from the activity log.
 */
describe('every way a card comes to rest on a person', () => {
  it('an agent that blocks says so, and replaces its own question', async () => {
    await runInDurableObject(await board('park-blocked', 'brd_pb1'), async (b: BoardDO) => {
      const card = await mustCreate(b);
      const c = await b.claim(CODER);
      if (!c.claimed) throw new Error('expected a claim');
      await b.postActivity({
        runId: c.runId,
        leaseEpoch: c.leaseEpoch,
        agentId: CODER.agentId,
        type: 'elicitation',
        body: 'May I run the test suite?',
        signal: 'select',
        parameter: { options: OPTIONS } as never,
      });
      expect((await read(b, card.id)).needsHuman?.reason).toBe('question');

      await b.block({ runId: c.runId, leaseEpoch: c.leaseEpoch, reason: 'no permission to run the script' });

      const got = await read(b, card.id);
      expect(got.state).toBe('input-required');
      expect(got.needsHuman?.reason).toBe('blocked');
      expect(got.needsHuman?.detail).toContain('no permission');
      // The question it asked is cancelled, so nothing may still point at it.
      expect(got.needsHuman?.elicitationId).toBeUndefined();
    });
  });

  it('a card submitted for human review says it is waiting for review', async () => {
    await runInDurableObject(await board('park-review', 'brd_pb2'), async (b: BoardDO) => {
      const card = await mustCreate(b);
      const c = await b.claim(CODER);
      if (!c.claimed) throw new Error('expected a claim');

      await b.submitForReview({ runId: c.runId, leaseEpoch: c.leaseEpoch });

      const got = await read(b, card.id);
      expect(got.state).toBe('input-required');
      expect(got.needsHuman?.reason).toBe('review');
    });
  });

  it('a stage whose completion was not met says what was missing', async () => {
    // The D1 refusal: blocked rather than failed, so a retry loop cannot burn budget
    // re-asserting the same untrue claim. A person has to see it, which means the card
    // has to say it.
    await runInDurableObject(await board('park-unmet', 'brd_pb3'), async (b: BoardDO) => {
      await b.setStages([
        { key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'code',
          completion: { handoff: ['verdict'] } },
        { key: 'verify', name: 'Verify', order: 1, ownerKind: 'capability', owner: 'test' },
      ]);
      const card = await mustCreate(b);
      const c = await b.claim(CODER);
      if (!c.claimed) throw new Error('expected a claim');

      await b.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'in progress' } });

      const got = await read(b, card.id);
      expect(got.state).toBe('input-required');
      expect(got.needsHuman?.reason).toBe('blocked');
      expect(got.needsHuman?.detail).toContain('verdict');
    });
  });
});

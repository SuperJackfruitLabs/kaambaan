import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit, type CardView, type ElicitationView } from '../src/board/board-do';

/**
 * The elicitation return path (docs/04 §4, docs/08 §6). An agent that stops to ask a question puts
 * the card in `input-required` — and until now nothing could answer it: the question was emitted as
 * an activity and forgotten, no record existed to answer, and the `input-required → working`
 * transition the state machine already defines was never invoked. A card whose work needs a human
 * decision (a permission prompt, a choice) was therefore terminally stuck.
 *
 * These tests pin the whole path: the question persists, the agent that holds the run can read it
 * and its answer, a human's answer moves the card back to `working`, and the agent that asked can
 * never answer itself.
 */

const PIPELINE: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
];

const init = (id = 'brd_elicit'): BoardInit => ({ id, tenantId: 'tnt_a', name: 'Elicitations', stages: PIPELINE });

const RESEARCHER = { agentId: 'agt_r', capabilities: ['research'] };
const HUMAN = 'usr_h';
const FAR_FUTURE = 8_000_000_000_000; // well past any heartbeat deadline

const OPTIONS = [
  { name: 'run_them', title: 'Run the tests' },
  { name: 'skip', title: 'Skip them' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function mustCreate(board: BoardDO, title: string): Promise<CardView> {
  const r = await board.createCard({ title, ownerUserId: 'usr_a' });
  if (!r.ok) throw new Error(`createCard failed: ${r.message}`);
  return r.value;
}

/** Claim a card and stop on a question, exactly as a harness that hit a permission prompt would. */
async function askAQuestion(
  board: BoardDO,
  opts: { signal?: string; parameter?: unknown; body?: string } = {},
): Promise<{ runId: string; leaseEpoch: number; cardId: string }> {
  const c = await board.claim(RESEARCHER);
  if (!c.claimed) throw new Error('expected a claim');
  const posted = await board.postActivity({
    runId: c.runId,
    leaseEpoch: c.leaseEpoch,
    agentId: RESEARCHER.agentId,
    type: 'elicitation',
    body: opts.body ?? 'May I run the test suite?',
    signal: opts.signal ?? 'select',
    parameter: (opts.parameter ?? { options: OPTIONS }) as never,
  });
  expect(posted.ok).toBe(true);
  return { runId: c.runId, leaseEpoch: c.leaseEpoch, cardId: c.card.id };
}

/** The elicitations on a run, as the agent that owns the run reads them. */
async function elicitationsOf(board: BoardDO, runId: string, agentId = RESEARCHER.agentId): Promise<ElicitationView[]> {
  const ctx = await board.getRunContext({ runId, agentId });
  if (!ctx.ok) throw new Error(`getRunContext failed: ${ctx.message}`);
  return ctx.value.elicitations;
}

describe('BoardDO — an elicitation is persisted, not just emitted', () => {
  it('records the question, its options and who asked it', async () => {
    await runInDurableObject(stubFor('elc-persist'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Add a feature');
      const { runId, cardId } = await askAQuestion(board);

      const [elicitation] = await elicitationsOf(board, runId);
      expect(elicitation).toBeDefined();
      expect(elicitation!).toMatchObject({
        cardId,
        runId,
        agentId: 'agt_r',
        stageKey: 'research',
        question: 'May I run the test suite?',
        signal: 'select',
        status: 'pending',
        answer: null,
      });
      expect(elicitation!.id).toMatch(/^elc_/);
      expect(elicitation!.options).toEqual(OPTIONS);
    });
  });

  it('reads the options out of `parameter` — the field the board actually carries', async () => {
    await runInDurableObject(stubFor('elc-parameter'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Options in parameter');
      // A bare array is accepted alongside `{ options: [...] }`; both are `parameter`.
      const { runId } = await askAQuestion(board, { parameter: OPTIONS });
      expect((await elicitationsOf(board, runId))[0]!.options).toEqual(OPTIONS);
    });
  });

  it('surfaces the pending question on the board snapshot, for the human who must answer it', async () => {
    await runInDurableObject(stubFor('elc-snapshot'), async (board: BoardDO) => {
      await board.init(init());
      const card = await mustCreate(board, 'Snapshot me');
      await askAQuestion(board);
      const snapshot = await board.getState();
      expect(snapshot.elicitations).toHaveLength(1);
      expect(snapshot.elicitations[0]).toMatchObject({ cardId: card.id, status: 'pending' });
    });
  });

  it('leaves the card in input-required with the agent still holding its lease', async () => {
    await runInDurableObject(stubFor('elc-card-state'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Waiting');
      const { runId } = await askAQuestion(board);
      const card = (await board.getState()).cards[0]!;
      expect(card.state).toBe('input-required');
      expect(card.delegateAgentId).toBe('agt_r');
      const ctx = await board.getRunContext({ runId, agentId: RESEARCHER.agentId });
      expect(ctx.ok && ctx.value.run.status).toBe('working');
    });
  });

  it('is not readable through another agent’s token — the run read surface is run-scoped', async () => {
    await runInDurableObject(stubFor('elc-foreign'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Mine only');
      const { runId } = await askAQuestion(board);
      const ctx = await board.getRunContext({ runId, agentId: 'agt_other' });
      expect(ctx.ok).toBe(false);
      if (!ctx.ok) expect(ctx.code).toBe('NOT_RUN_OWNER');
    });
  });
});

describe('BoardDO — a human answers, and the answer reaches the blocked agent', () => {
  it('transitions the card input-required → working and hands the agent the answer', async () => {
    await runInDurableObject(stubFor('elc-answer'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Answer me');
      const { runId } = await askAQuestion(board);
      const elicitationId = (await elicitationsOf(board, runId))[0]!.id;

      const answered = await board.answerElicitation({
        elicitationId,
        answeredBy: HUMAN,
        option: 'run_them',
        text: 'go ahead',
      });
      expect(answered.ok).toBe(true);
      if (!answered.ok) return;
      expect(answered.value.card.state).toBe('working');
      expect(answered.value.card.delegateAgentId).toBe('agt_r'); // the same agent picks up where it stopped

      // …and the agent, polling the run it holds, sees the answer without any human credential.
      const [elicitation] = await elicitationsOf(board, runId);
      expect(elicitation!.status).toBe('answered');
      expect(elicitation!.answer).toMatchObject({ option: 'run_them', text: 'go ahead', answeredBy: HUMAN });
    });
  });

  it('accepts a free-text answer when the agent offered no options', async () => {
    await runInDurableObject(stubFor('elc-freetext'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Open question');
      const { runId } = await askAQuestion(board, { parameter: undefined, body: 'Which repo?' });
      const elicitationId = (await elicitationsOf(board, runId))[0]!.id;
      const answered = await board.answerElicitation({ elicitationId, answeredBy: HUMAN, text: 'kaambaan' });
      expect(answered.ok).toBe(true);
      const [elicitation] = await elicitationsOf(board, runId);
      expect(elicitation!.answer).toMatchObject({ option: null, text: 'kaambaan' });
    });
  });

  it('refuses an answer that is not one of the offered options', async () => {
    await runInDurableObject(stubFor('elc-badoption'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Pick one');
      const { runId } = await askAQuestion(board);
      const elicitationId = (await elicitationsOf(board, runId))[0]!.id;
      const r = await board.answerElicitation({ elicitationId, answeredBy: HUMAN, option: 'rm_-rf' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ANSWER');
      expect((await board.getState()).cards[0]!.state).toBe('input-required');
    });
  });

  it('refuses an empty answer', async () => {
    await runInDurableObject(stubFor('elc-empty'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Say something');
      const { runId } = await askAQuestion(board);
      const elicitationId = (await elicitationsOf(board, runId))[0]!.id;
      const r = await board.answerElicitation({ elicitationId, answeredBy: HUMAN });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ANSWER');
    });
  });

  it('records the answer as a `prompt` activity, so the card’s replay shows the human’s turn', async () => {
    await runInDurableObject(stubFor('elc-activity'), async (board: BoardDO) => {
      await board.init(init());
      const card = await mustCreate(board, 'Replay');
      const { runId } = await askAQuestion(board);
      const elicitationId = (await elicitationsOf(board, runId))[0]!.id;
      await board.answerElicitation({ elicitationId, answeredBy: HUMAN, option: 'run_them' });

      const { activities } = await board.getCardActivities(card.id);
      const prompt = activities.find((a) => a.type === 'prompt');
      expect(prompt).toBeDefined();
      expect(prompt!.runId).toBe(runId);
      expect(prompt!.body).toContain('Run the tests');
    });
  });

  it('answers an auth-required elicitation through the account_linked transition', async () => {
    await runInDurableObject(stubFor('elc-auth'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Link the account');
      const { runId } = await askAQuestion(board, {
        signal: 'auth',
        parameter: undefined,
        body: 'Link GitHub to continue',
      });
      expect((await board.getState()).cards[0]!.state).toBe('auth-required');
      const elicitationId = (await elicitationsOf(board, runId))[0]!.id;
      const answered = await board.answerElicitation({ elicitationId, answeredBy: HUMAN, text: 'linked' });
      expect(answered.ok).toBe(true);
      if (answered.ok) expect(answered.value.card.state).toBe('working');
    });
  });
});

describe('BoardDO — who may answer', () => {
  it('refuses the agent that asked: an elicitation an agent can answer itself is decorative', async () => {
    await runInDurableObject(stubFor('elc-sod'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Self-serve?');
      const { runId } = await askAQuestion(board);
      const elicitationId = (await elicitationsOf(board, runId))[0]!.id;

      const r = await board.answerElicitation({ elicitationId, answeredBy: RESEARCHER.agentId, option: 'run_them' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SEPARATION_OF_DUTIES');

      // The card is untouched: still waiting, still unanswered.
      expect((await board.getState()).cards[0]!.state).toBe('input-required');
      const [elicitation] = await elicitationsOf(board, runId);
      expect(elicitation!.status).toBe('pending');
      expect(elicitation!.answer).toBeNull();
    });
  });
});

describe('BoardDO — answering twice, and never answering', () => {
  it('is a typed conflict the second time, not a second transition', async () => {
    await runInDurableObject(stubFor('elc-twice'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Once only');
      const { runId } = await askAQuestion(board);
      const elicitationId = (await elicitationsOf(board, runId))[0]!.id;

      const first = await board.answerElicitation({ elicitationId, answeredBy: HUMAN, option: 'run_them' });
      expect(first.ok).toBe(true);
      const second = await board.answerElicitation({ elicitationId, answeredBy: 'usr_other', option: 'skip' });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.code).toBe('ELICITATION_NOT_PENDING');

      // The first answer stands and the card moved exactly once.
      const [elicitation] = await elicitationsOf(board, runId);
      expect(elicitation!.answer).toMatchObject({ option: 'run_them', answeredBy: HUMAN });
      expect((await board.getState()).cards[0]!.state).toBe('working');
    });
  });

  it('reports an unknown elicitation rather than silently doing nothing', async () => {
    await runInDurableObject(stubFor('elc-missing'), async (board: BoardDO) => {
      await board.init(init());
      const r = await board.answerElicitation({ elicitationId: 'elc_nope', answeredBy: HUMAN, text: 'hi' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('ELICITATION_NOT_FOUND');
    });
  });

  it('leaves an unanswered card exactly as it behaves today: parked, then reclaimed and re-queued', async () => {
    await runInDurableObject(stubFor('elc-unanswered'), async (board: BoardDO) => {
      await board.init(init());
      await mustCreate(board, 'Nobody answers');
      const { runId } = await askAQuestion(board);
      expect((await board.getState()).cards[0]!.state).toBe('input-required');

      // Nobody answers; the agent's heartbeat lapses and the run is reclaimed (docs/08 §3).
      expect(board.reclaimExpired(FAR_FUTURE)).toBe(1);
      const card = (await board.getState()).cards[0]!;
      expect(card.state).toBe('submitted'); // back in the queue, exactly as before this feature
      expect(card.delegateAgentId).toBeNull();

      // The question died with the run it belonged to — answering it now is refused, not applied
      // to a card that has moved on.
      const elicitationId = (await elicitationsOf(board, runId))[0]!.id;
      const r = await board.answerElicitation({ elicitationId, answeredBy: HUMAN, option: 'run_them' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('ELICITATION_NOT_PENDING');
      expect((await board.getState()).cards[0]!.state).toBe('submitted');
      expect((await board.getState()).elicitations).toHaveLength(0);
    });
  });

  it('cancels a pending question when a human drags the card elsewhere (no stranded prompt)', async () => {
    await runInDurableObject(stubFor('elc-move'), async (board: BoardDO) => {
      await board.init(init());
      const card = await mustCreate(board, 'Moved away');
      const { runId } = await askAQuestion(board);
      await board.moveCard(card.id, 'build', HUMAN);

      expect((await board.getState()).elicitations).toHaveLength(0);
      const elicitationId = (await elicitationsOf(board, runId))[0]!.id;
      const r = await board.answerElicitation({ elicitationId, answeredBy: HUMAN, option: 'run_them' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('ELICITATION_NOT_PENDING');
    });
  });
});

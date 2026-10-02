import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit, type CardView } from '../src/board/board-do';

/**
 * Two facts a board owns and did not emit (spec:
 * docs/superpowers/specs/2026-10-02-a-question-leaves-the-board-design.md).
 *
 * 1. **Its own name.** Every board's Matrix room was named the literal string
 *    `superpipeline`, because the hub could never learn what a board was called and
 *    cannot ask — `/v1/members` resolves a user SESSION, the same wall that forced
 *    `humansFor` to be injected on the hub side. The board knew the whole time.
 *
 * 2. **That an agent is blocked on a question.** A gate reaches a phone because
 *    `gate.pending` is pushed. An elicitation — which is what every permission prompt
 *    is — only emitted internally and filed an in-app notification, so nothing outside
 *    the web app could know a run had stopped to ask. That is the whole reason a
 *    permission meant opening a browser.
 *
 * The answering half already existed here: the table, `parseElicitationOptions` (which
 * already accepts the Matrix `{id,label}` spelling), the answer route, and separation of
 * duties enforced by identity inside the DO. Only the telling was missing.
 */

const PIPELINE: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
];

const HOOK = 'https://hub.example/api/bridge/superpipeline/push';
const RESEARCHER = { agentId: 'agt_r', capabilities: ['research'] };

const OPTIONS = [
  { name: 'run_them', title: 'Run the tests' },
  { name: 'skip', title: 'Skip them' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function mustCreate(board: BoardDO, title = 'Add OAuth login'): Promise<CardView> {
  const r = await board.createCard({ title, ownerUserId: 'usr_a' });
  if (!r.ok) throw new Error(`createCard failed: ${r.message}`);
  return r.value;
}

/** Claim and stop on a question, exactly as a harness that hit a permission prompt would. */
async function askAQuestion(
  board: BoardDO,
  opts: { parameter?: unknown; body?: string; title?: string; agentId?: string } = {},
): Promise<{ runId: string; leaseEpoch: number; cardId: string }> {
  await mustCreate(board, opts.title ?? 'Add OAuth login');
  // One run per agent, so a second question needs a second worker.
  const agentId = opts.agentId ?? RESEARCHER.agentId;
  const c = await board.claim({ agentId, capabilities: RESEARCHER.capabilities });
  if (!c.claimed) throw new Error('expected a claim');
  const posted = await board.postActivity({
    runId: c.runId,
    leaseEpoch: c.leaseEpoch,
    agentId,
    type: 'elicitation',
    body: opts.body ?? 'May I run the test suite?',
    signal: 'select',
    // `in`, not `??`: a test that passes an explicit `null` is testing the
    // no-options case, and `??` would quietly hand it the default instead.
    parameter: ('parameter' in opts ? opts.parameter : { options: OPTIONS }) as never,
  });
  if (!posted.ok) throw new Error('expected the question to post');
  return { runId: c.runId, leaseEpoch: c.leaseEpoch, cardId: c.card.id };
}

/** Drive research→complete so the card lands on the review gate. */
async function openGate(board: BoardDO): Promise<string> {
  const card = await mustCreate(board);
  const c = await board.claim(RESEARCHER);
  if (!c.claimed) throw new Error('expected a research claim');
  await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'drafted' } });
  return card.id;
}

const elicitationPushes = (deliveries: Array<{ body: string }>) =>
  deliveries.map((d) => JSON.parse(d.body)).filter((b) => b.event === 'elicitation.pending');

describe('a gate carries its board name', () => {
  it('sends the name the board was created with', async () => {
    await runInDurableObject(stubFor('qlb-name'), async (board: BoardDO) => {
      await board.init({ id: 'brd_n', tenantId: 'tnt_a', name: 'Client Quality', stages: PIPELINE });
      await board.registerPushConfig({ agentId: 'a', url: HOOK, token: 's', events: ['gate.pending'] });
      await openGate(board);

      const body = JSON.parse((await board.getPushDeliveries())[0]!.body);
      expect(body.boardName).toBe('Client Quality');
    });
  });

  it('still produces a usable body when the board has no name', async () => {
    // The hub falls back to the id. A body that omitted the field and a body that
    // carried an empty string must both be survivable, because the hub's fallback is
    // the thing standing between this and a room renamed to `undefined`.
    await runInDurableObject(stubFor('qlb-noname'), async (board: BoardDO) => {
      await board.init({ id: 'brd_nn', tenantId: 'tnt_a', name: '', stages: PIPELINE });
      await board.registerPushConfig({ agentId: 'a', url: HOOK, token: 's', events: ['gate.pending'] });
      await openGate(board);

      const body = JSON.parse((await board.getPushDeliveries())[0]!.body);
      expect(body.event).toBe('gate.pending');
      expect(body.boardId).toBe('brd_nn');
      // Present and empty, not absent: `?? ''` here would pass before the field
      // existed at all, which is a test that proves nothing.
      expect(Object.hasOwn(body, 'boardName')).toBe(true);
      expect(body.boardName).toBe('');
    });
  });
});

describe('elicitation.pending — telling somebody a run is blocked', () => {
  it('queues a delivery carrying everything a projection needs', async () => {
    await runInDurableObject(stubFor('qlb-queue'), async (board: BoardDO) => {
      await board.init({ id: 'brd_e', tenantId: 'tnt_a', name: 'Client Quality', stages: PIPELINE });
      await board.registerPushConfig({
        agentId: 'agt_bridge', url: HOOK, token: 's3cret', capabilities: [], events: ['elicitation.pending'],
      });
      const { cardId, runId } = await askAQuestion(board);

      const pushes = elicitationPushes(await board.getPushDeliveries());
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({
        event: 'elicitation.pending',
        boardId: 'brd_e',
        boardName: 'Client Quality',
        cardId,
        cardTitle: 'Add OAuth login',
        runId,
        stageKey: 'research',
        agentId: 'agt_r',
        question: 'May I run the test suite?',
      });
      expect(pushes[0].elicitationId).toMatch(/^elc_/);
      expect(typeof pushes[0].ts).toBe('string');
    });
  });

  it('sends the option ids the answer route resolves against, not the board vocabulary', async () => {
    await runInDurableObject(stubFor('qlb-options'), async (board: BoardDO) => {
      await board.init({ id: 'brd_eo', tenantId: 'tnt_a', name: 'B', stages: PIPELINE });
      await board.registerPushConfig({ agentId: 'a', url: HOOK, token: 's', events: ['elicitation.pending'] });
      await askAQuestion(board);

      const [push] = elicitationPushes(await board.getPushDeliveries());
      // `name`→`id`, `title`→`label`, in the order the agent offered them. The board's
      // own spelling stops at this boundary, as `gatePendingBody` already says.
      expect(push.options).toEqual([
        { id: 'run_them', label: 'Run the tests' },
        { id: 'skip', label: 'Skip them' },
      ]);
    });
  });

  it('is sent for a question with no options at all', async () => {
    // Silence would otherwise mean two different things: "no question" and "a question
    // nobody can tap". The hub needs the second so it can say where to answer.
    await runInDurableObject(stubFor('qlb-noopts'), async (board: BoardDO) => {
      await board.init({ id: 'brd_ez', tenantId: 'tnt_a', name: 'B', stages: PIPELINE });
      await board.registerPushConfig({ agentId: 'a', url: HOOK, token: 's', events: ['elicitation.pending'] });
      await askAQuestion(board, { parameter: null, body: 'What should the headline say?' });

      const [push] = elicitationPushes(await board.getPushDeliveries());
      expect(push).toBeDefined();
      expect(push.options).toEqual([]);
      expect(push.question).toBe('What should the headline say?');
    });
  });

  it('does not send a question to a config that only asked for work.available', async () => {
    // The mistake this guards is copying `notifyWorkAvailable`'s capability match: a
    // question is addressed to a human, and matching on capability would deliver it to
    // whichever agents advertise the stage — or, for a human-owned stage, to nobody.
    await runInDurableObject(stubFor('qlb-unsub'), async (board: BoardDO) => {
      await board.init({ id: 'brd_eu', tenantId: 'tnt_a', name: 'B', stages: PIPELINE });
      await board.registerPushConfig({
        agentId: 'agt_worker', url: HOOK, token: 's', capabilities: ['research'], events: ['work.available'],
      });
      await askAQuestion(board);

      expect(elicitationPushes(await board.getPushDeliveries())).toHaveLength(0);
    });
  });
});

describe('pendingElicitationDeliveries — the floor beneath push', () => {
  it('returns a pending question in the shape a push carries', async () => {
    await runInDurableObject(stubFor('qlb-pend'), async (board: BoardDO) => {
      await board.init({ id: 'brd_p', tenantId: 'tnt_a', name: 'Client Quality', stages: PIPELINE });
      const { cardId } = await askAQuestion(board);

      const pending = await board.pendingElicitationDeliveries();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        event: 'elicitation.pending',
        boardId: 'brd_p',
        boardName: 'Client Quality',
        cardId,
        agentId: 'agt_r',
      });
    });
  });

  it('is independent of whether anything subscribed', async () => {
    // The whole reason it exists: push is retried five times and then dead-lettered, at
    // which point the fact is silent on both sides. It is also what makes the per-board
    // push-config rollout non-blocking.
    await runInDurableObject(stubFor('qlb-nosub'), async (board: BoardDO) => {
      await board.init({ id: 'brd_ns', tenantId: 'tnt_a', name: 'B', stages: PIPELINE });
      await askAQuestion(board);

      expect(await board.getPushDeliveries()).toHaveLength(0);
      expect(await board.pendingElicitationDeliveries()).toHaveLength(1);
    });
  });

  it('drops a question that was answered', async () => {
    await runInDurableObject(stubFor('qlb-answered'), async (board: BoardDO) => {
      await board.init({ id: 'brd_a', tenantId: 'tnt_a', name: 'B', stages: PIPELINE });
      await askAQuestion(board);
      const [pending] = await board.pendingElicitationDeliveries();

      const answered = await board.answerElicitation({
        elicitationId: pending!.elicitationId,
        answeredBy: 'usr_h',
        option: 'run_them',
      });
      expect(answered.ok).toBe(true);

      expect(await board.pendingElicitationDeliveries()).toHaveLength(0);
    });
  });

  it('drops a question a newer one superseded, and keeps the newer one', async () => {
    // `openElicitation` retires the previous question on the same card. Absence from
    // this list is how the hub learns to settle a room card nobody can answer any more
    // — and a stale tappable question is a question that will be tapped.
    await runInDurableObject(stubFor('qlb-superseded'), async (board: BoardDO) => {
      await board.init({ id: 'brd_s', tenantId: 'tnt_a', name: 'B', stages: PIPELINE });
      const { runId, leaseEpoch } = await askAQuestion(board, { body: 'First?' });

      const second = await board.postActivity({
        runId,
        leaseEpoch,
        agentId: RESEARCHER.agentId,
        type: 'elicitation',
        body: 'Second?',
        signal: 'select',
        parameter: { options: OPTIONS } as never,
      });
      expect(second.ok).toBe(true);

      const pending = await board.pendingElicitationDeliveries();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.question).toBe('Second?');
    });
  });

  it('orders oldest first, across cards', async () => {
    await runInDurableObject(stubFor('qlb-order'), async (board: BoardDO) => {
      await board.init({ id: 'brd_o', tenantId: 'tnt_a', name: 'B', stages: PIPELINE });
      await askAQuestion(board, { title: 'First card', body: 'Older?' });
      await askAQuestion(board, { title: 'Second card', body: 'Newer?', agentId: 'agt_r2' });

      const pending = await board.pendingElicitationDeliveries();
      expect(pending.map((p) => p.question)).toEqual(['Older?', 'Newer?']);
    });
  });
});

describe('what the hub must not be able to do, now that it is a second caller', () => {
  it('refuses the asking agent by identity', async () => {
    await runInDurableObject(stubFor('qlb-sod'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sod', tenantId: 'tnt_a', name: 'B', stages: PIPELINE });
      await askAQuestion(board);
      const [pending] = await board.pendingElicitationDeliveries();

      const self = await board.answerElicitation({
        elicitationId: pending!.elicitationId,
        answeredBy: RESEARCHER.agentId,
        option: 'run_them',
      });
      expect(self.ok).toBe(false);
    });
  });

  it('refuses an option that was never offered', async () => {
    await runInDurableObject(stubFor('qlb-badopt'), async (board: BoardDO) => {
      await board.init({ id: 'brd_bo', tenantId: 'tnt_a', name: 'B', stages: PIPELINE });
      await askAQuestion(board);
      const [pending] = await board.pendingElicitationDeliveries();

      const bogus = await board.answerElicitation({
        elicitationId: pending!.elicitationId,
        answeredBy: 'usr_h',
        option: 'rm_rf',
      });
      expect(bogus.ok).toBe(false);
    });
  });

  it('refuses a question that is already answered', async () => {
    await runInDurableObject(stubFor('qlb-twice'), async (board: BoardDO) => {
      await board.init({ id: 'brd_tw', tenantId: 'tnt_a', name: 'B', stages: PIPELINE });
      await askAQuestion(board);
      const [pending] = await board.pendingElicitationDeliveries();

      const first = await board.answerElicitation({
        elicitationId: pending!.elicitationId, answeredBy: 'usr_h', option: 'skip',
      });
      expect(first.ok).toBe(true);
      const again = await board.answerElicitation({
        elicitationId: pending!.elicitationId, answeredBy: 'usr_h', option: 'skip',
      });
      expect(again.ok).toBe(false);
    });
  });
});

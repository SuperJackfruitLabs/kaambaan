import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

/**
 * Archiving a card ends what was waiting on a person for it (observed 2026-10-10: seven pending
 * gates whose cards were archived still sat in Needs you / `supi gates`).
 *
 * A manual move already cancels a card's pending gates and questions; archive is the other way a
 * card leaves the working set and did none of it. These pin that archive does the same, through the
 * same code, and that restoring a card never brings a cancelled gate back.
 */
const REVIEW: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
];
const ASKING: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
];
const SUBJECT_STAGES = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
  {
    key: 'approve', name: 'Approve', order: 1, ownerKind: 'human', gate: 'approval',
    approvalSubjectSchema: 'social-publish/v1', approvalDeciderPrincipalIds: ['usr_reviewer'],
  },
] as unknown as BoardInit['stages'];
const PAYLOAD = {
  channel: 'x',
  account: { platform: 'x', userId: 'acct_1', username: 'example' },
  items: [{ index: 0, text: 'hello', media: [], replyToPostId: null, quotePostId: null }],
  timing: { mode: 'immediate', notBefore: null, expiresAt: '2030-01-02T03:04:05Z' },
  evidenceRefs: ['https://example.invalid/e'],
  policy: { allowThread: true, duplicatePolicyId: 'd', floodPolicyId: 'f' },
};
const HOOK = 'https://hub.example/api/bridge/superpipeline/push';
const ARCHIVED = '2026-10-10T08:00:00.000Z';

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

/** Create a card and drive it onto the review gate. */
async function cardAtReview(board: BoardDO, title: string, projectId?: string): Promise<string> {
  const card = await board.createCard({ title, ownerUserId: 'usr_a', ...(projectId ? { projectId } : {}) });
  if (!card.ok) throw new Error(card.message);
  const c = await board.claim({ agentId: 'agt_r', capabilities: ['research', 'writing'] });
  if (!c.claimed) throw new Error('expected a claim');
  const done = await board.complete({
    runId: c.runId, leaseEpoch: c.leaseEpoch,
    handoff: projectId ? { publicationPayload: PAYLOAD } : { summary: 'drafted' },
  });
  if (!done.ok) throw new Error(done.message);
  return card.value.id;
}

const pendingFor = async (board: BoardDO, cardId: string) =>
  (await board.getState()).gates.filter((g) => g.cardId === cardId && g.status === 'pending');

describe('archiving a card ends what was waiting on a person', () => {
  it('cancels the card\'s pending gate, so it leaves every pending list', async () => {
    await runInDurableObject(stubFor('arch-gate'), async (board: BoardDO) => {
      await board.init({ id: 'brd_ag', tenantId: 'tnt_a', name: 'A', stages: REVIEW });
      const cardId = await cardAtReview(board, 'Post');
      expect(await pendingFor(board, cardId)).toHaveLength(1);

      const r = await board.updateCard(cardId, { archivedAt: ARCHIVED });
      expect(r.ok).toBe(true);

      expect(await pendingFor(board, cardId)).toHaveLength(0);
      expect(await board.pendingGateDeliveries()).toHaveLength(0);
    });
  });

  it('records the gate as cancelled with a resolution time, readable by id', async () => {
    await runInDurableObject(stubFor('arch-gate-read'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_agr', tenantId: 'tnt_a', name: 'A', stages: REVIEW });
      const cardId = await cardAtReview(board, 'Post');
      const gateId = (await pendingFor(board, cardId))[0]!.id;
      await board.updateCard(cardId, { archivedAt: ARCHIVED });
      const row = state.storage.sql.exec(`SELECT status, resolved_at FROM gates WHERE id = ?`, gateId).one();
      expect(row.status).toBe('cancelled');
      expect(row.resolved_at).toEqual(expect.any(String));
      const read = await board.getGate(gateId);
      expect(read.ok && read.value.status).toBe('cancelled');
    });
  });

  it('cancels the card\'s pending question', async () => {
    await runInDurableObject(stubFor('arch-elc'), async (board: BoardDO) => {
      await board.init({ id: 'brd_ae', tenantId: 'tnt_a', name: 'E', stages: ASKING });
      const card = await board.createCard({ title: 'Add a feature', ownerUserId: 'usr_a' });
      if (!card.ok) throw new Error(card.message);
      const c = await board.claim({ agentId: 'agt_r', capabilities: ['research'] });
      if (!c.claimed) throw new Error('claim');
      await board.postActivity({
        runId: c.runId, leaseEpoch: c.leaseEpoch, agentId: 'agt_r', type: 'elicitation',
        body: 'May I?', signal: 'select', parameter: { options: [{ name: 'y', title: 'Yes' }] } as never,
      });
      expect(await board.pendingElicitationDeliveries()).toHaveLength(1);

      await board.updateCard(card.value.id, { archivedAt: ARCHIVED });

      expect(await board.pendingElicitationDeliveries()).toHaveLength(0);
      expect((await board.getState()).elicitations.filter((e) => e.status === 'pending')).toHaveLength(0);
    });
  });

  it('invalidates the active approval subject so a sealed approval cannot outlive the card', async () => {
    await runInDurableObject(stubFor('arch-subject'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_as', tenantId: 'tnt_a', name: 'S', stages: SUBJECT_STAGES });
      const cardId = await cardAtReview(board, 'Sealed', 'prj_1');
      const sql = state.storage.sql;
      expect(sql.exec(`SELECT status FROM approval_subjects WHERE card_id = ?`, cardId).one().status).toBe('active');

      await board.updateCard(cardId, { archivedAt: ARCHIVED });

      const subject = sql.exec(`SELECT status, invalidation_reason FROM approval_subjects WHERE card_id = ?`, cardId).one();
      expect(subject.status).toBe('invalidated');
      expect(subject.invalidation_reason).toBe('card.archived');
      expect(sql.exec(`SELECT active_approval_subject_id AS s FROM cards WHERE id = ?`, cardId).one().s).toBeNull();
      expect(await pendingFor(board, cardId)).toHaveLength(0);
    });
  });

  it('is relayed: the card update is pushed and the gate is gone from the reconcile list', async () => {
    await runInDurableObject(stubFor('arch-relay'), async (board: BoardDO) => {
      await board.init({ id: 'brd_ar', tenantId: 'tnt_a', name: 'R', stages: REVIEW });
      await board.registerPushConfig({
        agentId: 'agt_bridge', url: HOOK, token: 's', capabilities: [], events: ['gate.pending', 'card.updated'],
      });
      const cardId = await cardAtReview(board, 'Post');
      expect((await board.pendingGateDeliveries()).map((b) => b.cardId)).toEqual([cardId]);
      const before = (await board.getPushDeliveries()).length;

      await board.updateCard(cardId, { archivedAt: ARCHIVED });

      const bodies = (await board.getPushDeliveries()).slice(before).map((d) => JSON.parse(d.body));
      expect(bodies.map((b) => b.event)).toContain('card.updated');
      expect(await board.pendingGateDeliveries()).toEqual([]);
    });
  });

  it('leaves another card\'s gate alone', async () => {
    await runInDurableObject(stubFor('arch-other'), async (board: BoardDO) => {
      await board.init({ id: 'brd_ao', tenantId: 'tnt_a', name: 'O', stages: REVIEW });
      const a = await cardAtReview(board, 'A');
      const b = await cardAtReview(board, 'B');
      await board.updateCard(a, { archivedAt: ARCHIVED });
      expect(await pendingFor(board, a)).toHaveLength(0);
      expect(await pendingFor(board, b)).toHaveLength(1);
    });
  });

  it('does not touch a card that is not being archived (an ordinary edit keeps its gate)', async () => {
    await runInDurableObject(stubFor('arch-edit'), async (board: BoardDO) => {
      await board.init({ id: 'brd_ad', tenantId: 'tnt_a', name: 'D', stages: REVIEW });
      const a = await cardAtReview(board, 'A');
      await board.updateCard(a, { title: 'A2' });
      await board.updateCard(a, { archivedAt: null });
      expect(await pendingFor(board, a)).toHaveLength(1);
    });
  });
});

describe('a gate whose card is archived is never listed as pending', () => {
  it('even if one is stored (the reads do not depend on the cancel having run)', async () => {
    await runInDurableObject(stubFor('arch-read-filter'), async (board: BoardDO, state) => {
      await board.init({ id: 'brd_rf', tenantId: 'tnt_a', name: 'F', stages: REVIEW });
      const a = await cardAtReview(board, 'A');
      const b = await cardAtReview(board, 'B');
      state.storage.sql.exec(`UPDATE cards SET archived_at = ? WHERE id = ?`, ARCHIVED, a);
      expect((await board.getState()).gates.map((g) => g.cardId)).toEqual([b]);
      expect((await board.pendingGateDeliveries()).map((g) => g.cardId)).toEqual([b]);
    });
  });
});

describe('restoring an archived card', () => {
  it('does not resurrect the cancelled gate, and says why the card is waiting', async () => {
    await runInDurableObject(stubFor('unarch'), async (board: BoardDO) => {
      await board.init({ id: 'brd_un', tenantId: 'tnt_a', name: 'U', stages: REVIEW });
      const a = await cardAtReview(board, 'A');
      await board.updateCard(a, { archivedAt: ARCHIVED });
      const restored = await board.updateCard(a, { archivedAt: null });
      expect(restored.ok).toBe(true);

      expect(await pendingFor(board, a)).toHaveLength(0);
      expect(await board.pendingGateDeliveries()).toHaveLength(0);
      if (!restored.ok) return;
      // Parked for a person, with a reason - not a silent card in input-required.
      expect(restored.value.state).toBe('input-required');
      expect(restored.value.needsHuman).toMatchObject({ reason: 'blocked' });
      expect(restored.value.needsHuman?.detail).toMatch(/archived/);
      // ...and the existing recovery path works: resume it to the stage that produced the work.
      const resumed = await board.resumeCard({
        cardId: a, comment: 'restored', toStageKey: 'research', actor: { id: 'usr_a', name: null },
      });
      expect(resumed.ok).toBe(true);
    });
  });
});

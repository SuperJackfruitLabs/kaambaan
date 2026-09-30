import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

const TWO_STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
  { key: 'ship', name: 'Ship', order: 1, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('child cards', () => {
  it('inherits priority but NOT labels, matching Linear', async () => {
    await runInDurableObject(stubFor('sub-inherit'), async (board: BoardDO) => {
      await board.init({ id: 'brd_si', tenantId: 'tnt_a', name: 'SI', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a', priority: 7 });
      if (!p.ok) throw new Error(p.message);
      await board.updateCard(p.value.id, { labels: ['lbl_aaaaaaaaaaaaaaaa'] });

      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error(child.message);
      expect(child.value.priority).toBe(7);
      expect(child.value.labels).toEqual([]);
      expect(child.value.parentCardId).toBe(p.value.id);
    });
  });

  it('reports the parent’s open child count', async () => {
    await runInDurableObject(stubFor('sub-count'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sc', tenantId: 'tnt_a', name: 'SC', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!p.ok) throw new Error(p.message);
      await board.createChildCard(p.value.id, { title: 'One', ownerUserId: 'usr_a' });
      await board.createChildCard(p.value.id, { title: 'Two', ownerUserId: 'usr_a' });
      const parent = (await board.getState()).cards.find((c) => c.id === p.value.id)!;
      expect(parent.openChildCount).toBe(2);
    });
  });

  it('rolls cost up WITHOUT changing costUsd, which feeds the budget gate', async () => {
    await runInDurableObject(stubFor('sub-cost'), async (board: BoardDO) => {
      await board.init({ id: 'brd_scost', tenantId: 'tnt_a', name: 'SCost', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!p.ok) throw new Error(p.message);
      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error(child.message);

      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      // `UsageInput` is `{ model?, inputTokens?, outputTokens?, costUsd? }` (board-do.ts:385) —
      // NOT ACP's `{ used, size, cost }`. The two are easy to confuse because the bridge translates
      // between them; the DO only ever sees this shape.
      await board.postActivity({
        runId: c.runId, leaseEpoch: c.leaseEpoch, type: 'thought', body: 'working',
        usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.25 },
      });

      const cards = (await board.getState()).cards;
      const parent = cards.find((x) => x.id === p.value.id)!;
      const kid = cards.find((x) => x.id === child.value.id)!;
      expect(kid.costUsd).toBeCloseTo(0.25, 5);
      // The parent spent nothing itself. costUsd must stay 0 or `overBudget` moves.
      expect(parent.costUsd).toBe(0);
      expect(parent.costUsdRollup).toBeCloseTo(0.25, 5);
    });
  });

  it('refuses a child of a card that does not exist', async () => {
    await runInDurableObject(stubFor('sub-missing'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sm', tenantId: 'tnt_a', name: 'SM', stages: STAGES });
      const r = await board.createChildCard('card_nope', { title: 'Orphan', ownerUserId: 'usr_a' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('NO_SUCH_CARD');
    });
  });
});

describe('the deferred advance', () => {
  it('parks a mid-run split parent until the last child resolves, then advances it with the handoff intact', async () => {
    await runInDurableObject(stubFor('sub-defer-advance'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sda', tenantId: 'tnt_a', name: 'SDA', stages: TWO_STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!p.ok) throw new Error(p.message);

      // The agent claims the parent, then splits it mid-run — exactly the `superpipeline_split_card`
      // shape (Task 15): the child is created while the parent's own run is still open.
      const cParent = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!cParent.claimed) throw new Error('expected the parent to be claimable');
      expect(cParent.card.id).toBe(p.value.id);

      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error(child.message);

      // `complete()` must still succeed — the agent did its stage and the lease has to release.
      const completed = await board.complete({
        runId: cParent.runId,
        leaseEpoch: cParent.leaseEpoch,
        handoff: { summary: 'split into one child' },
      });
      expect(completed.ok).toBe(true);
      if (!completed.ok) throw new Error(completed.message);
      // Withheld: the advance, not the completion. Parked in its CURRENT stage, not re-queued into
      // it and not advanced to 'ship'.
      expect(completed.value.currentStageKey).toBe('draft');
      expect(completed.value.state).toBe('input-required');
      expect(completed.value.openChildCount).toBe(1);

      // Genuinely unclaimable: the only thing claim() can hand out now is the child.
      const cChild1 = await board.claim({ agentId: 'agt_w2', capabilities: ['writing'] });
      if (!cChild1.claimed) throw new Error('expected the child to be claimable');
      expect(cChild1.card.id).toBe(child.value.id);

      // Finish the child's first stage — it is NOT yet resolved (still `submitted` on `ship`), so
      // the parent must still be parked.
      await board.complete({ runId: cChild1.runId, leaseEpoch: cChild1.leaseEpoch, handoff: { summary: 'child drafted' } });
      const midParent = (await board.getState()).cards.find((c) => c.id === p.value.id)!;
      expect(midParent.state).toBe('input-required');
      expect(midParent.currentStageKey).toBe('draft');

      // Resolve the child's LAST stage — this is the trigger.
      const cChild2 = await board.claim({ agentId: 'agt_w3', capabilities: ['writing'] });
      if (!cChild2.claimed) throw new Error('expected the child to be claimable again, on ship');
      expect(cChild2.card.id).toBe(child.value.id);
      await board.complete({ runId: cChild2.runId, leaseEpoch: cChild2.leaseEpoch, handoff: { summary: 'child shipped' } });

      // The deferred advance replays now: the parent moves from 'draft' to 'ship', submitted, with
      // its OWN handoff intact — not the child's.
      const state = await board.getState();
      const finalParent = state.cards.find((c) => c.id === p.value.id)!;
      expect(finalParent.currentStageKey).toBe('ship');
      expect(finalParent.state).toBe('submitted');
      expect(finalParent.openChildCount).toBe(0);
      const activities = await board.getCardActivities(p.value.id);
      expect(activities.handoff).toEqual({ summary: 'split into one child' });

      // And it is claimable again, exactly once — not stuck, not double-fired.
      const cParent2 = await board.claim({ agentId: 'agt_w4', capabilities: ['writing'] });
      if (!cParent2.claimed) throw new Error('expected the parent to be claimable again, on ship');
      expect(cParent2.card.id).toBe(p.value.id);
    });
  });

  it('does not reach completed on its last stage while children are open, and nothing blocked by it unblocks', async () => {
    await runInDurableObject(stubFor('sub-defer-lastage'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sdl', tenantId: 'tnt_a', name: 'SDL', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      const neighbour = await board.createCard({ title: 'Neighbour', ownerUserId: 'usr_a' });
      if (!p.ok || !neighbour.ok) throw new Error('setup failed');
      await board.addLink({ fromCardId: p.value.id, toCardId: neighbour.value.id, kind: 'blocks' });

      const cParent = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!cParent.claimed) throw new Error('expected the parent to be claimable');
      expect(cParent.card.id).toBe(p.value.id);

      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error(child.message);

      // STAGES has exactly one stage, so an unguarded advance here would write 'completed' outright
      // — which is precisely the leak this task closes: it would also resolve the `blocks` edge and
      // unblock `neighbour` while the parent's own subtree is still open.
      const completed = await board.complete({ runId: cParent.runId, leaseEpoch: cParent.leaseEpoch, handoff: { summary: 'split' } });
      expect(completed.ok).toBe(true);
      if (!completed.ok) throw new Error(completed.message);
      expect(completed.value.state).not.toBe('completed');
      expect(completed.value.state).toBe('input-required');

      // Only the child is claimable — not the parked parent, and not the still-blocked neighbour.
      const cChild = await board.claim({ agentId: 'agt_w2', capabilities: ['writing'] });
      if (!cChild.claimed) throw new Error('expected the child to be claimable');
      expect(cChild.card.id).toBe(child.value.id);

      // Resolve the child — the only stage it has, so this is its true terminal `completed`.
      await board.complete({ runId: cChild.runId, leaseEpoch: cChild.leaseEpoch, handoff: { summary: 'child done' } });

      const state = await board.getState();
      const finalParent = state.cards.find((c) => c.id === p.value.id)!;
      expect(finalParent.state).toBe('completed');

      // Containment held until the parent itself resolved: NOW the neighbour is claimable.
      const cNeighbour = await board.claim({ agentId: 'agt_w3', capabilities: ['writing'] });
      if (!cNeighbour.claimed) throw new Error('expected the neighbour to be claimable now that the parent resolved');
      expect(cNeighbour.card.id).toBe(neighbour.value.id);
    });
  });

  it('advances immediately when children were already resolved before it completes, as today', async () => {
    await runInDurableObject(stubFor('sub-defer-already-resolved'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sdr', tenantId: 'tnt_a', name: 'SDR', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!p.ok) throw new Error(p.message);
      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error(child.message);

      // Resolve the child BEFORE the parent ever completes.
      const cChild = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!cChild.claimed) throw new Error('expected the child to be claimable');
      await board.complete({ runId: cChild.runId, leaseEpoch: cChild.leaseEpoch, handoff: { summary: 'child done' } });

      const cParent = await board.claim({ agentId: 'agt_w2', capabilities: ['writing'] });
      if (!cParent.claimed) throw new Error('expected the parent to be claimable');
      const completed = await board.complete({ runId: cParent.runId, leaseEpoch: cParent.leaseEpoch, handoff: { summary: 'parent done' } });
      expect(completed.ok).toBe(true);
      // No open children at advance time — straight through, no park.
      if (completed.ok) expect(completed.value.state).toBe('completed');
    });
  });

  // `openChildCount` is a live join over `card_links` — it cannot tell a resolved child from a
  // vanished one. So a parked parent's last open child leaving the open set by being deleted, or by
  // having its `parent` edge removed, has to resume the park exactly as completion does, or the
  // parent is stranded with nothing left to ever recheck it (`resumeParentAdvanceIfFree`).
  it('also resumes a parked parent when its last open child is deleted instead of resolved', async () => {
    await runInDurableObject(stubFor('sub-defer-child-deleted'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sdcd', tenantId: 'tnt_a', name: 'SDCD', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!p.ok) throw new Error(p.message);

      // Claim the parent BEFORE the child exists — once it has an open child, `blockedWhere`
      // (Task 13) excludes the parent from claim() entirely, so the child has to be created
      // mid-run, same as the split-card path this mirrors.
      const cParent = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!cParent.claimed) throw new Error('expected the parent to be claimable');
      expect(cParent.card.id).toBe(p.value.id);

      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error(child.message);

      const completed = await board.complete({ runId: cParent.runId, leaseEpoch: cParent.leaseEpoch, handoff: { summary: 'split' } });
      expect(completed.ok).toBe(true);
      if (completed.ok) expect(completed.value.state).toBe('input-required'); // parked on the open child

      const deleted = await board.deleteCard(child.value.id);
      expect(deleted.ok).toBe(true);

      const finalParent = (await board.getState()).cards.find((c) => c.id === p.value.id)!;
      expect(finalParent.openChildCount).toBe(0);
      expect(finalParent.state).toBe('completed'); // resumed, not stranded
    });
  });

  it('also resumes a parked parent when its last open child is un-parented via removeLink', async () => {
    await runInDurableObject(stubFor('sub-defer-child-unparented'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sdcu', tenantId: 'tnt_a', name: 'SDCU', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!p.ok) throw new Error(p.message);

      // Same ordering reason as the delete test above: claim the parent before the child exists.
      const cParent = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!cParent.claimed) throw new Error('expected the parent to be claimable');
      expect(cParent.card.id).toBe(p.value.id);

      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error(child.message);

      const completed = await board.complete({ runId: cParent.runId, leaseEpoch: cParent.leaseEpoch, handoff: { summary: 'split' } });
      expect(completed.ok).toBe(true);
      if (completed.ok) expect(completed.value.state).toBe('input-required'); // parked on the open child

      const unlinked = await board.removeLink(p.value.id, child.value.id, 'parent');
      expect(unlinked.ok).toBe(true);

      const finalParent = (await board.getState()).cards.find((c) => c.id === p.value.id)!;
      expect(finalParent.openChildCount).toBe(0);
      expect(finalParent.state).toBe('completed'); // resumed, not stranded
    });
  });
});

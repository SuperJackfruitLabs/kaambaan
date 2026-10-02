import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

/**
 * A card that reaches a last stage nobody can act on is finished.
 *
 * `state = 'completed'` had exactly one writer: `advanceCard`, when a run ends and there is no next
 * stage. For a HUMAN-owned terminal stage the only thing that reaches it is resolving an approval
 * gate — so a terminal stage that is human-owned and declares no gate could never complete a card
 * at all. No agent may claim it (human-owned), no gate will ever ask anyone, and no route sets card
 * state. Cards arrived there and stayed `submitted` forever.
 *
 * All four SHIPPED templates end in exactly that shape (`shipped`, `published`, `closed`, `ready`),
 * so every board created from one was born unable to express completion — 8 of 10 boards in the
 * estate that found this.
 *
 * The rule is narrowed to the case where it is provably safe: a terminal stage nobody can act on.
 * The two excluded cases are excluded because something CAN act, and completing on arrival would
 * destroy that act — an agent's run, or a human's review.
 */
const HUMAN_END: BoardInit['stages'] = [
  { key: 'doing', name: 'Doing', order: 0, ownerKind: 'capability', owner: 'code' },
  { key: 'done', name: 'Done', order: 1, ownerKind: 'human' },
];
const GATED_END: BoardInit['stages'] = [
  { key: 'doing', name: 'Doing', order: 0, ownerKind: 'capability', owner: 'code' },
  { key: 'resident', name: 'Resident', order: 1, ownerKind: 'human', gate: 'approval' },
];
const AGENT_END: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'human' },
  { key: 'publish', name: 'Publish', order: 1, ownerKind: 'capability', owner: 'code' },
];

async function claimAndComplete(board: BoardDO, caps: string[]): Promise<void> {
  const run = await board.claim({ agentId: 'agt_w', capabilities: caps });
  if (!run.claimed) throw new Error('expected a claim');
  await board.complete({ runId: run.runId, leaseEpoch: run.leaseEpoch, handoff: { summary: 'done' } });
}

describe('arriving at a last stage nobody can act on completes the card', () => {
  it('an AGENT advancing into a gateless human end stage completes it', async () => {
    await runInDurableObject(stubFor('term-1'), async (board: BoardDO) => {
      await board.init({ id: 'brd_t1', tenantId: 'tnt_a', name: 'T', stages: HUMAN_END });
      const c = await board.createCard({ title: 'Ship it', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');
      await claimAndComplete(board, ['code']);

      const after = await board.getCardView(c.value.id);
      if (!after.ok) throw new Error('read');
      expect(after.value.currentStageKey).toBe('done');
      // The card sits in the last stage AND reads as resolved — not `submitted`, which is what it
      // used to read forever.
      expect(after.value.state).toBe('completed');
    });
  });

  it('a HUMAN moving a card there completes it too, because that is how a person says "finished"', async () => {
    await runInDurableObject(stubFor('term-2'), async (board: BoardDO) => {
      await board.init({ id: 'brd_t2', tenantId: 'tnt_a', name: 'T', stages: HUMAN_END });
      const c = await board.createCard({ title: 'Drag me to done', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');

      const moved = await board.moveCard(c.value.id, 'done', 'usr_a');
      if (!moved.ok) throw new Error('move failed');
      expect(moved.value.currentStageKey).toBe('done');
      expect(moved.value.state).toBe('completed');
    });
  });

  it('DOES NOT complete a gated end stage — the review must still happen', async () => {
    // The regression this guards. `resident` and an incident board's `closed` both end in a human
    // approval, and that approval is the step where somebody confirms the work. Completing on
    // arrival would delete the checkpoint and nobody would notice, because the card would look
    // finished.
    await runInDurableObject(stubFor('term-3'), async (board: BoardDO) => {
      await board.init({ id: 'brd_t3', tenantId: 'tnt_a', name: 'T', stages: GATED_END });
      const c = await board.createCard({ title: 'Needs a nod', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');
      await claimAndComplete(board, ['code']);

      const after = await board.getCardView(c.value.id);
      if (!after.ok) throw new Error('read');
      expect(after.value.currentStageKey).toBe('resident');
      expect(after.value.state).toBe('input-required');

      // `pendingGates` is private; the snapshot is how a client sees them, which is the surface
      // that matters — a gate nothing can render is a review nobody performs.
      const snap = await board.getState();
      expect(snap.gates.map((g) => g.cardId)).toContain(c.value.id);
    });
  });

  it('DOES NOT complete an agent-owned end stage — the work has not happened yet', async () => {
    // The dangerous case. If arrival completed the card, the final publish/deploy would never run
    // and the board would say it had.
    await runInDurableObject(stubFor('term-4'), async (board: BoardDO) => {
      await board.init({ id: 'brd_t4', tenantId: 'tnt_a', name: 'T', stages: AGENT_END });
      const c = await board.createCard({ title: 'Publish me', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');

      const moved = await board.moveCard(c.value.id, 'publish', 'usr_a');
      if (!moved.ok) throw new Error('move failed');
      expect(moved.value.state).toBe('submitted');

      // And it is genuinely still claimable, which is the whole point.
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['code'] });
      if (!claim.claimed) throw new Error('expected the final stage to still be claimable');
      expect(claim.card.id).toBe(c.value.id);
    });
  });

  it('a card with open children is still DEFERRED, not completed', async () => {
    // `advanceCard` parks a parent whose subtree is open rather than resolving it — "a parent with
    // half-finished children would read as done". That rule outranks this one.
    await runInDurableObject(stubFor('term-5'), async (board: BoardDO) => {
      await board.init({ id: 'brd_t5', tenantId: 'tnt_a', name: 'T', stages: HUMAN_END });
      const parent = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!parent.ok) throw new Error('parent');
      const child = await board.createChildCard(parent.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error('child');

      // `moveCard` REFUSES a parent with open children outright (Task 13's guard) rather than
      // deferring the way the agent path does. Either way the card does not reach `completed`,
      // which is the property being pinned.
      const moved = await board.moveCard(parent.value.id, 'done', 'usr_a');
      expect(moved.ok).toBe(false);
      const still = await board.getCardView(parent.value.id);
      if (!still.ok) throw new Error('read');
      expect(still.value.state).not.toBe('completed');
    });
  });
});

describe('the backfill rescues cards already stranded', () => {
  it('completes a card sitting in a dead-end terminal stage, and leaves everything else alone', async () => {
    // The new rule fixes arrivals from now on. It does nothing for a card that arrived BEFORE it
    // existed — and there were seven of those across two boards, with eight of ten boards shaped to
    // produce more. A card nobody can act on, in a stage nobody can act on, is not a state anyone
    // chose; it is the absence of this rule, recorded.
    await runInDurableObject(stubFor('term-6'), async (board: BoardDO) => {
      await board.init({ id: 'brd_t6', tenantId: 'tnt_a', name: 'T', stages: HUMAN_END });

      const stranded = await board.createCard({ title: 'Stranded', ownerUserId: 'usr_a' });
      const working = await board.createCard({ title: 'Still being worked', ownerUserId: 'usr_a' });
      if (!stranded.ok || !working.ok) throw new Error('cards');

      // Put one into the end stage the way the old code did: in the stage, state `submitted`.
      await board.debugForceCardState(stranded.value.id, 'done', 'submitted');

      const { completed } = await board.backfillTerminalStageCards();
      expect(completed).toBe(1);

      const a = await board.getCardView(stranded.value.id);
      const b = await board.getCardView(working.value.id);
      if (!a.ok || !b.ok) throw new Error('read');
      expect(a.value.state).toBe('completed');
      // The card still in a working stage is untouched — the backfill is keyed on the STAGE, not
      // on the state alone.
      expect(b.value.state).toBe('submitted');
      expect(b.value.currentStageKey).toBe('doing');
    });
  });

  it('is idempotent, so a retry costs nothing and changes nothing', async () => {
    await runInDurableObject(stubFor('term-7'), async (board: BoardDO) => {
      await board.init({ id: 'brd_t7', tenantId: 'tnt_a', name: 'T', stages: HUMAN_END });
      const c = await board.createCard({ title: 'Once', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');
      await board.debugForceCardState(c.value.id, 'done', 'submitted');

      expect((await board.backfillTerminalStageCards()).completed).toBe(1);
      expect((await board.backfillTerminalStageCards()).completed).toBe(0);
    });
  });

  it('does NOT touch a card parked on a gated end stage awaiting review', async () => {
    await runInDurableObject(stubFor('term-8'), async (board: BoardDO) => {
      await board.init({ id: 'brd_t8', tenantId: 'tnt_a', name: 'T', stages: GATED_END });
      const c = await board.createCard({ title: 'Awaiting a nod', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');
      await board.debugForceCardState(c.value.id, 'resident', 'input-required');

      expect((await board.backfillTerminalStageCards()).completed).toBe(0);
      const after = await board.getCardView(c.value.id);
      if (!after.ok) throw new Error('read');
      expect(after.value.state).toBe('input-required');
    });
  });

  it('does NOT complete a stranded card whose children are still open', async () => {
    await runInDurableObject(stubFor('term-9'), async (board: BoardDO) => {
      await board.init({ id: 'brd_t9', tenantId: 'tnt_a', name: 'T', stages: HUMAN_END });
      const parent = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!parent.ok) throw new Error('parent');
      const child = await board.createChildCard(parent.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error('child');
      await board.debugForceCardState(parent.value.id, 'done', 'submitted');

      // Same precedence the live rule follows: "a parent with half-finished children would read as
      // done" outranks resolving it.
      expect((await board.backfillTerminalStageCards()).completed).toBe(0);
    });
  });
});

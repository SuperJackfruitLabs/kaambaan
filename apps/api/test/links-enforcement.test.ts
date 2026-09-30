import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
  { key: 'ship', name: 'Ship', order: 1, ownerKind: 'capability', owner: 'writing' },
];

// research (agent) -> review (human approval gate) -> ship (agent) — the only way to drive a card
// to a genuinely unresolved-terminal state ('rejected') without a verb that writes 'failed' directly
// (nothing does; see the note on the mid-retry test below).
const GATED_STAGES: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'writing' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'ship', name: 'Ship', order: 2, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

/**
 * Wraps the DO's private `sql.exec` to record every query text from here forward. `sql` is a
 * private instance field (`this.sql = ctx.storage.sql`), not a prototype method, so reassigning it
 * is an ordinary JS monkeypatch — verified against the live `cloudflare:test` DO instance, not a
 * mock. Returns a reader that can be reset between checkpoints.
 */
function watchSqlExec(board: BoardDO): { queries: () => string[]; reset: () => void } {
  const target = (board as unknown as { sql: { exec: (...a: unknown[]) => unknown } }).sql;
  const orig = target.exec.bind(target);
  let log: string[] = [];
  target.exec = (...args: unknown[]) => {
    log.push(String(args[0]));
    return orig(...args);
  };
  return { queries: () => log, reset: () => { log = []; } };
}

async function two(board: BoardDO, name: string) {
  await board.init({ id: `brd_${name}`, tenantId: 'tnt_a', name, stages: STAGES });
  const a = await board.createCard({ title: 'Blocker', ownerUserId: 'usr_a' });
  const b = await board.createCard({ title: 'Blocked', ownerUserId: 'usr_a' });
  if (!a.ok || !b.ok) throw new Error('setup failed');
  return { a: a.value, b: b.value };
}

describe('a blocked card is not handed out', () => {
  it('is skipped in favour of a claimable one', async () => {
    await runInDurableObject(stubFor('enf-skip'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enfskip');
      // b is blocked by a. Give b the higher priority so only the block can explain the outcome.
      await board.updateCard(b.id, { priority: 9 });
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(a.id);
    });
  });

  it('reports no work when the ONLY card is blocked — not an error', async () => {
    await runInDurableObject(stubFor('enf-none'), async (board: BoardDO) => {
      await board.init({ id: 'brd_enfnone', tenantId: 'tnt_a', name: 'EN', stages: STAGES });
      const a = await board.createCard({ title: 'Blocker', ownerUserId: 'usr_a' });
      const b = await board.createCard({ title: 'Blocked', ownerUserId: 'usr_a' });
      if (!a.ok || !b.ok) throw new Error('setup failed');
      await board.updateCard(a.value.id, { archivedAt: '2026-09-30T00:00:00.000Z' });
      await board.addLink({ fromCardId: a.value.id, toCardId: b.value.id, kind: 'blocks' });
      // An archived blocker is still unresolved. `{claimed:false}` is correct and is what the
      // bridge already handles — there is no new refusal code on this path.
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(false);
    });
  });

  it('unblocks once the blocker completes', async () => {
    await runInDurableObject(stubFor('enf-unblock'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enfunblock');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      // `a` must reach the true terminal `completed` state — STAGES has two stages, and finishing
      // only the first one advances `a` to `ship` as `submitted`, which correctly does NOT resolve
      // it (the earlier draft of this test asserted the wrong thing for exactly this reason).
      const c1 = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c1.claimed) throw new Error('expected a claim');
      expect(c1.card.id).toBe(a.id);
      await board.complete({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, handoff: { summary: 'drafted' } });

      // `a` is now `ship`/submitted — not resolved yet, so `b` is still excluded. The only
      // claimable card is `a` again, mid-pipeline.
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(1);
      const c2 = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c2.claimed) throw new Error('expected a claim again — b is still blocked');
      expect(c2.card.id).toBe(a.id);
      await board.complete({ runId: c2.runId, leaseEpoch: c2.leaseEpoch, handoff: { summary: 'shipped' } });

      const next = await board.claim({ agentId: 'agt_w2', capabilities: ['writing'] });
      if (!next.claimed) throw new Error('expected b to be claimable now');
      expect(next.card.id).toBe(b.id);
    });
  });

  it('does not advertise a blocked card either — countReadyForCapabilities agrees with claim', async () => {
    await runInDurableObject(stubFor('enf-count'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enfcount');
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(2);
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      // One claimable (the blocker), one excluded (the blocked card).
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(1);
    });
  });

  /**
   * ⚠️ HONESTLY LABELLED — see the brief's warning. `board.fail()` ends the *attempt*, not the
   * card: `endAttempt` writes `'input-required'` only once the circuit breaker trips (2 failures
   * here), otherwise `'submitted'`. One `fail()` call leaves the blocker `submitted`, mid-retry —
   * NOT `'failed'`, which no implemented verb ever writes to a card row. This test asserts the
   * blocker's actual state before asserting the dependent stays blocked, so it cannot be cited
   * later as proof a *failed* blocker blocks (see the next test for that).
   */
  it('keeps the dependent blocked while the blocker is mid-retry (state stays submitted, not failed)', async () => {
    await runInDurableObject(stubFor('enf-midretry'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enfmidretry');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      const failed = await board.fail({ runId: c.runId, leaseEpoch: c.leaseEpoch, reason: 'could not do it' });
      if (!failed.ok) throw new Error('fail should not itself be refused');
      // The state this test actually drives — asserted, not assumed.
      expect(failed.value.state).toBe('submitted');
      // `a` itself returns to the queue mid-retry — it, not `b`, is what the next claim picks up,
      // and only ONE card is ready. A bare `claimed === false` here would be wrong: `a` is still
      // claimable (that is what "mid-retry" means), so the correct check is that `b` stays
      // excluded, not that nothing is claimable at all.
      expect(await board.countReadyForCapabilities('agt_w2', ['writing'])).toBe(1);
      const retry = await board.claim({ agentId: 'agt_w2', capabilities: ['writing'] });
      if (!retry.claimed) throw new Error('expected a to be reclaimable, mid-retry');
      expect(retry.card.id).toBe(a.id);
    });
  });

  /**
   * The genuinely unresolved-terminal case: `rejected`, reached via a gate rejection — the only
   * state-writing path that is reachable AND not `completed`/`canceled`. `'failed'` cannot be
   * driven by any verb, so it is not tested here (or anywhere) — see the previous test.
   */
  it('keeps the dependent blocked while the blocker is rejected (a genuinely unresolved terminal state)', async () => {
    await runInDurableObject(stubFor('enf-rejected'), async (board: BoardDO) => {
      await board.init({ id: 'brd_enfrejected', tenantId: 'tnt_a', name: 'ENR', stages: GATED_STAGES });
      const aR = await board.createCard({ title: 'Blocker', ownerUserId: 'usr_a' });
      const bR = await board.createCard({ title: 'Blocked', ownerUserId: 'usr_a' });
      if (!aR.ok || !bR.ok) throw new Error('setup failed');
      const a = aR.value;
      const b = bR.value;
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });

      // Drive `a` onto the review gate, then reject it.
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed || c.card.id !== a.id) throw new Error('expected a to be claimed first (b is blocked)');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'drafted' } });
      const gates = (await board.getState()).gates.filter((g) => g.cardId === a.id && g.status === 'pending');
      if (gates.length !== 1) throw new Error(`expected one pending gate on a, got ${gates.length}`);
      const resolved = await board.resolveGate({ gateId: gates[0]!.id, decision: 'reject', decidedBy: 'usr_reviewer' });
      if (!resolved.ok) throw new Error('resolveGate should not itself be refused');

      // The state this test actually drives — asserted, not assumed.
      expect(resolved.value.state).toBe('rejected');
      expect((await board.claim({ agentId: 'agt_w2', capabilities: ['writing'] })).claimed).toBe(false);
    });
  });

  it('`relates` blocks nothing', async () => {
    await runInDurableObject(stubFor('enf-relates'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enfrelates');
      await board.updateCard(b.id, { priority: 9 });
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'relates' });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(b.id);
    });
  });
});

describe('a parent does not advance past an open child', () => {
  it('refuses with CARD_BLOCKED, and allows it once the child is resolved', async () => {
    await runInDurableObject(stubFor('enf-parent'), async (board: BoardDO) => {
      const { a: parent, b: child } = await two(board, 'enfparent');
      await board.addLink({ fromCardId: parent.id, toCardId: child.id, kind: 'parent' });

      const refused = await board.moveCard(parent.id, 'ship', 'usr_a');
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe('CARD_BLOCKED');

      // The child must reach the true terminal `completed` state — STAGES has two stages, and
      // finishing only the first leaves it `submitted` on `ship`, still open.
      const c1 = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c1.claimed) throw new Error('expected the child to be claimable');
      expect(c1.card.id).toBe(child.id);
      await board.complete({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, handoff: { summary: 'child drafted' } });

      // Still refused: the child is on `ship` now, submitted, not resolved.
      const stillRefused = await board.moveCard(parent.id, 'ship', 'usr_a');
      expect(stillRefused.ok).toBe(false);
      if (!stillRefused.ok) expect(stillRefused.code).toBe('CARD_BLOCKED');

      const c2 = await board.claim({ agentId: 'agt_w2', capabilities: ['writing'] });
      if (!c2.claimed) throw new Error('expected the child to be claimable again, on ship');
      expect(c2.card.id).toBe(child.id);
      await board.complete({ runId: c2.runId, leaseEpoch: c2.leaseEpoch, handoff: { summary: 'child shipped' } });

      const allowed = await board.moveCard(parent.id, 'ship', 'usr_a');
      expect(allowed.ok).toBe(true);
    });
  });

  it('a human move through an unresolved `blocks` edge is allowed and recorded (Principle 3)', async () => {
    await runInDurableObject(stubFor('enf-human-override'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enfoverride');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });

      // b is blocked (a is unresolved), but a human dragging it is allowed through — it is not an
      // open CHILD, only an unresolved blocker, and Principle 3 says a human owns the card.
      const moved = await board.moveCard(b.id, 'ship', 'usr_a');
      expect(moved.ok).toBe(true);
      if (moved.ok) expect(moved.value.currentStageKey).toBe('ship');

      const notifications = await board.getNotifications();
      expect(notifications.some((n) => n.kind === 'moved-while-blocked' && n.cardId === b.id)).toBe(true);
    });
  });
});

// Shape follows test/board-push.test.ts:14 — register, act, read getPushDeliveries().
describe('the third eligibility site: push notifications respect the blocked rule', () => {
  const HOOK = 'https://agent.example/hook';

  it('does not queue a work.available delivery for a blocked card', async () => {
    await runInDurableObject(stubFor('enf-push-blocked'), async (board: BoardDO) => {
      await board.init({ id: 'brd_enfpushblocked', tenantId: 'tnt_a', name: 'EPB', stages: STAGES });
      const reg = await board.registerPushConfig({ agentId: 'agt_w', url: HOOK, token: 's', capabilities: ['writing'], events: ['work.available'] });
      expect(reg.ok).toBe(true);

      const aR = await board.createCard({ title: 'Blocker', ownerUserId: 'usr_a' }); // delivery #1
      const bR = await board.createCard({ title: 'Blocked', ownerUserId: 'usr_a' }); // delivery #2 (not blocked yet)
      if (!aR.ok || !bR.ok) throw new Error('setup failed');
      const a = aR.value;
      const b = bR.value;

      // Claim both (a first — created first, same priority — then b) so each has a live run, then
      // link them: a now blocks b while a is `working` (unresolved either way).
      const ca = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!ca.claimed || ca.card.id !== a.id) throw new Error('expected to claim a first');
      const cb = await board.claim({ agentId: 'agt_w2', capabilities: ['writing'] });
      if (!cb.claimed || cb.card.id !== b.id) throw new Error('expected to claim b next');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      expect(await board.getPushDeliveries()).toHaveLength(2); // unchanged by addLink itself

      // Failing b's run re-queues it (`endAttempt` -> `notifyWorkAvailable`) — this is the exact
      // path `test/board-push.test.ts`'s `'re-notifies when a failed run returns the card to the
      // queue'` test exercises for an UNblocked card. Here `b` is blocked (by `a`, still
      // `working`), so `isHeldBack` must suppress the re-queue ping — no third delivery.
      await board.fail({ runId: cb.runId, leaseEpoch: cb.leaseEpoch, reason: 'retry' });
      expect(await board.getPushDeliveries()).toHaveLength(2);
    });
  });

  it('fans out work.available to a dependent once its blocker genuinely resolves', async () => {
    await runInDurableObject(stubFor('enf-push-fanout'), async (board: BoardDO) => {
      await board.init({ id: 'brd_enfpushfanout', tenantId: 'tnt_a', name: 'EPF', stages: STAGES });

      // Cards created, and linked, BEFORE the push config is registered — so neither creation
      // queues a delivery, and the only `work.available` pings that can appear are the ones this
      // test is actually about (`b`'s creation would otherwise queue one of its own, since it
      // isn't blocked until the link below exists, which would pollute `forB()`'s count).
      const aR = await board.createCard({ title: 'Blocker', ownerUserId: 'usr_a' });
      const bR = await board.createCard({ title: 'Blocked', ownerUserId: 'usr_a' });
      if (!aR.ok || !bR.ok) throw new Error('setup failed');
      const a = aR.value;
      const b = bR.value;
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      await board.registerPushConfig({ agentId: 'agt_w', url: HOOK, token: 's', capabilities: ['writing'], events: ['work.available'] });

      const forB = async () =>
        (await board.getPushDeliveries()).filter((d) => (JSON.parse(d.body) as { cardId: string }).cardId === b.id);

      // `a` must reach the true terminal `completed` state (STAGES has two stages — see the note on
      // the 'unblocks once the blocker completes' test above for why one `complete()` is not enough).
      const c1 = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c1.claimed || c1.card.id !== a.id) throw new Error('expected to claim a');
      await board.complete({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, handoff: { summary: 'drafted' } });
      // `a` re-enters the queue at `ship`, still unresolved — nothing should fire for `b` yet.
      expect(await forB()).toHaveLength(0);

      const c2 = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c2.claimed || c2.card.id !== a.id) throw new Error('expected to claim a again, on ship');
      await board.complete({ runId: c2.runId, leaseEpoch: c2.leaseEpoch, handoff: { summary: 'shipped' } });

      // `a` is now genuinely `completed` — `b` must be pinged directly, not merely discoverable on
      // the next `list_work` poll. Without the fan-out, `notifyWorkAvailable` is only ever called
      // for the card that just changed (`a`), never for `a`'s dependents, so this assertion is
      // exactly what fails without it.
      expect(await forB()).toHaveLength(1);
    });
  });
});

describe('CardView.blockedBy', () => {
  it('reports an unresolved same-board blocker, with its title', async () => {
    await runInDurableObject(stubFor('blockedby-unresolved'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'bbunresolved');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      const bCard = (await board.getState()).cards.find((c) => c.id === b.id)!;
      expect(bCard.blockedBy).toEqual([{ cardId: a.id, title: 'Blocker' }]);
    });
  });

  it('is empty once the blocker reaches a genuinely resolved state (completed)', async () => {
    await runInDurableObject(stubFor('blockedby-completed'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'bbcompleted');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      // Drive `a` through both stages to genuinely `completed` — STAGES has two stages, and
      // finishing only the first leaves it `submitted` on `ship`, still unresolved (see the
      // 'unblocks once the blocker completes' test above for the same two-step shape).
      const c1 = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c1.claimed || c1.card.id !== a.id) throw new Error('expected to claim a first');
      await board.complete({ runId: c1.runId, leaseEpoch: c1.leaseEpoch, handoff: { summary: 'drafted' } });
      const c2 = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c2.claimed || c2.card.id !== a.id) throw new Error('expected to claim a again, on ship');
      const completed = await board.complete({ runId: c2.runId, leaseEpoch: c2.leaseEpoch, handoff: { summary: 'shipped' } });
      if (!completed.ok) throw new Error('complete should not itself be refused');
      expect(completed.value.state).toBe('completed');

      const bCard = (await board.getState()).cards.find((c) => c.id === b.id)!;
      expect(bCard.blockedBy).toEqual([]);
    });
  });

  it('still reports a `rejected` blocker — rejected is terminal but not resolved', async () => {
    await runInDurableObject(stubFor('blockedby-rejected'), async (board: BoardDO) => {
      await board.init({ id: 'brd_bbrejected', tenantId: 'tnt_a', name: 'BBR', stages: GATED_STAGES });
      const aR = await board.createCard({ title: 'Blocker', ownerUserId: 'usr_a' });
      const bR = await board.createCard({ title: 'Blocked', ownerUserId: 'usr_a' });
      if (!aR.ok || !bR.ok) throw new Error('setup failed');
      const a = aR.value;
      const b = bR.value;
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });

      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed || c.card.id !== a.id) throw new Error('expected a to be claimed first (b is blocked)');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'drafted' } });
      const gates = (await board.getState()).gates.filter((g) => g.cardId === a.id && g.status === 'pending');
      if (gates.length !== 1) throw new Error(`expected one pending gate on a, got ${gates.length}`);
      const resolved = await board.resolveGate({ gateId: gates[0]!.id, decision: 'reject', decidedBy: 'usr_reviewer' });
      if (!resolved.ok) throw new Error('resolveGate should not itself be refused');
      expect(resolved.value.state).toBe('rejected');

      const bCard = (await board.getState()).cards.find((c) => c.id === b.id)!;
      expect(bCard.blockedBy).toEqual([{ cardId: a.id, title: 'Blocker' }]);
    });
  });

  it('an open child is NOT a blocker — blockedBy stays empty while openChildCount is not', async () => {
    await runInDurableObject(stubFor('blockedby-openchild'), async (board: BoardDO) => {
      await board.init({ id: 'brd_bboc', tenantId: 'tnt_a', name: 'BBOC', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!p.ok) throw new Error(p.message);
      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error(child.message);

      const parent = (await board.getState()).cards.find((c) => c.id === p.value.id)!;
      expect(parent.openChildCount).toBe(1);
      expect(parent.blockedBy).toEqual([]);
    });
  });

  it('a single-card read (e.g. right after claim) agrees with the batched board read', async () => {
    await runInDurableObject(stubFor('blockedby-single'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'bbsingle');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      // `a` itself is unblocked (nothing blocks it) — claim returns it via the single-card fallback
      // path in `rowToCard` (no `pre`), which must report the same shape as the batched path: `[]`.
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(a.id);
      expect(claim.card.blockedBy).toEqual([]);
    });
  });

  /**
   * The test above only exercises `rowToCard`'s single-card fallback (`blockersOf`) on an
   * UNBLOCKED card — `claim` can never return a blocked one, by construction. That leaves the
   * fallback's actual claim — "same predicate as the batched path" — unverified on the one shape
   * that matters: a card that IS blocked. `getCardView` (`board-do.ts:1782`) is the public RPC the
   * drawer's `GET /v1/boards/:id/cards/:cardId` route calls, and it goes straight through
   * `getCard` → `rowToCard(row)` with no `pre` — the exact non-batched path 17b's card drawer will
   * read from. "Correct by inspection, same predicate" is exactly the reasoning that let the
   * claim/discovery divergence into this plan once before; asserting the two paths agree on one
   * fixture is what actually proves it, and is what would break if a later edit touched one query
   * and not the other.
   */
  it('the single-card read (getCardView, the drawer\'s path) agrees with the batched read on a BLOCKED card', async () => {
    await runInDurableObject(stubFor('blockedby-single-blocked'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'bbsingleblocked');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });

      const single = await board.getCardView(b.id);
      if (!single.ok) throw new Error('expected getCardView to find b');
      expect(single.value.blockedBy).toEqual([{ cardId: a.id, title: 'Blocker' }]);

      const batched = (await board.getState()).cards.find((c) => c.id === b.id)!;
      expect(single.value.blockedBy).toEqual(batched.blockedBy);
    });
  });

  it('the single-card read also honours a `rejected` blocker — not just the batched read', async () => {
    await runInDurableObject(stubFor('blockedby-single-rejected'), async (board: BoardDO) => {
      await board.init({ id: 'brd_bbsr', tenantId: 'tnt_a', name: 'BBSR', stages: GATED_STAGES });
      const aR = await board.createCard({ title: 'Blocker', ownerUserId: 'usr_a' });
      const bR = await board.createCard({ title: 'Blocked', ownerUserId: 'usr_a' });
      if (!aR.ok || !bR.ok) throw new Error('setup failed');
      const a = aR.value;
      const b = bR.value;
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });

      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed || c.card.id !== a.id) throw new Error('expected a to be claimed first (b is blocked)');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'drafted' } });
      const gates = (await board.getState()).gates.filter((g) => g.cardId === a.id && g.status === 'pending');
      if (gates.length !== 1) throw new Error(`expected one pending gate on a, got ${gates.length}`);
      const resolved = await board.resolveGate({ gateId: gates[0]!.id, decision: 'reject', decidedBy: 'usr_reviewer' });
      if (!resolved.ok) throw new Error('resolveGate should not itself be refused');
      expect(resolved.value.state).toBe('rejected');

      const single = await board.getCardView(b.id);
      if (!single.ok) throw new Error('expected getCardView to find b');
      expect(single.value.blockedBy).toEqual([{ cardId: a.id, title: 'Blocker' }]);

      const batched = (await board.getState()).cards.find((cd) => cd.id === b.id)!;
      expect(single.value.blockedBy).toEqual(batched.blockedBy);
    });
  });

  it('is computed once per board read, not once per card (the batched path does not regress to N+1)', async () => {
    // A straight count of every `sql.exec` call during `getState()` is NOT usable here: rowToCard
    // already runs one unrelated per-card `SELECT v FROM meta …` (the budget-cap read), a
    // pre-existing N+1 outside this task's scope, so the raw total already scales with card count
    // for reasons that have nothing to do with `blockedBy`. Instead, watch for the ONE query shape
    // `blockedBy`'s batch query must have — it selects `blocker_id`/`blocker_title` for every
    // unresolved `blocks` edge on the board in a single unparameterised SELECT, unlike the
    // single-card fallback (`blockersOf`, `WHERE l.to_card_id = ?`) — and assert it appears exactly
    // once per `getState()` call, regardless of how many cards or `blocks` edges exist. A per-card
    // `blockedBy` query would instead make this count scale with the card count.
    const isBlockedByBatchQuery = (sql: string) => sql.includes('blocker_id');

    await runInDurableObject(stubFor('blockedby-scale'), async (board: BoardDO) => {
      await board.init({ id: 'brd_bbscale', tenantId: 'tnt_a', name: 'BBS', stages: STAGES });
      const a1 = await board.createCard({ title: 'A1', ownerUserId: 'usr_a' });
      const b1 = await board.createCard({ title: 'B1', ownerUserId: 'usr_a' });
      if (!a1.ok || !b1.ok) throw new Error('setup failed');
      await board.addLink({ fromCardId: a1.value.id, toCardId: b1.value.id, kind: 'blocks' });

      const watch = watchSqlExec(board);
      await board.getState();
      const small = watch.queries().filter(isBlockedByBatchQuery).length;
      expect(small).toBe(1);

      // Grow the board by an order of magnitude — more cards, more `blocks` edges.
      watch.reset();
      for (let i = 0; i < 10; i++) {
        const x = await board.createCard({ title: `X${i}`, ownerUserId: 'usr_a' });
        const y = await board.createCard({ title: `Y${i}`, ownerUserId: 'usr_a' });
        if (!x.ok || !y.ok) throw new Error('setup failed');
        await board.addLink({ fromCardId: x.value.id, toCardId: y.value.id, kind: 'blocks' });
      }

      watch.reset();
      await board.getState();
      const large = watch.queries().filter(isBlockedByBatchQuery).length;

      expect(large).toBe(1);
      expect(large).toBe(small);
    });
  });
});

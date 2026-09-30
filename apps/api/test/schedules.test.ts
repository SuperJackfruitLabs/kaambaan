import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function boardWithSchedule(board: BoardDO, name: string, patch: Record<string, unknown> = {}) {
  await board.init({ id: `brd_${name}`, tenantId: 'tnt_a', name, stages: STAGES });
  const r = await board.createSchedule({
    title: 'Sweep the logs',
    rule: 'daily at 09:00',
    timezone: 'UTC',
    overlap: 'skip',
    createdBy: 'usr_a',
    ...patch,
  });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe('schedules', () => {
  it('refuses an unreadable rule at creation, with the parser’s own message', async () => {
    await runInDurableObject(stubFor('sch-bad'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sb', tenantId: 'tnt_a', name: 'SB', stages: STAGES });
      const r = await board.createSchedule({
        title: 'x', rule: 'every 2 minutes', timezone: 'UTC', overlap: 'skip', createdBy: 'usr_a',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain('5');
    });
  });

  it('computes the first fire time at creation', async () => {
    await runInDurableObject(stubFor('sch-first'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schfirst');
      expect(s.nextFireAt).toMatch(/T09:00:00\.000Z$/);
    });
  });

  it('creates a card when due, and advances next_fire_at past it', async () => {
    await runInDurableObject(stubFor('sch-fire'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schfire');
      const result = await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      expect(result.fired).toEqual([s.id]);

      const cards = (await board.getState()).cards;
      expect(cards).toHaveLength(1);
      expect(cards[0]!.title).toBe('Sweep the logs');

      const after = (await board.listSchedules())[0]!;
      expect(new Date(after.nextFireAt).getTime()).toBeGreaterThan(new Date('2099-01-01T10:00:00.000Z').getTime());
      expect(after.lastCardId).toBe(cards[0]!.id);
    });
  });

  it('does not fire twice for one due time', async () => {
    await runInDurableObject(stubFor('sch-once'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schonce');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      const second = await board.fireDueSchedules('2099-01-01T10:01:00.000Z');
      expect(second.fired).toEqual([]);
      expect((await board.getState()).cards).toHaveLength(1);
    });
  });

  it('skips while the previous card is still open, and records the skip visibly', async () => {
    await runInDurableObject(stubFor('sch-skip'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schskip');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      const skipped = await board.fireDueSchedules('2099-01-03T10:00:00.000Z');

      expect(skipped.skipped).toEqual([s.id]);
      expect((await board.getState()).cards).toHaveLength(1);
      expect((await board.listSchedules())[0]!.skipCount).toBe(1);

      // A silent skip is the failure mode this guards against: it must be on the audit log.
      const events = await board.getEvents(50);
      expect(events.some((e) => e.type === 'schedule.skipped')).toBe(true);
    });
  });

  it('fires again once the previous card is finished', async () => {
    await runInDurableObject(stubFor('sch-resume'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schresume');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'swept' } });

      const again = await board.fireDueSchedules('2099-01-03T10:00:00.000Z');
      expect(again.fired).toHaveLength(1);
      expect((await board.getState()).cards).toHaveLength(2);
    });
  });

  it('fires regardless of an open card when overlap is allow', async () => {
    await runInDurableObject(stubFor('sch-allow'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schallow', { overlap: 'allow' });
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      await board.fireDueSchedules('2099-01-03T10:00:00.000Z');
      expect((await board.getState()).cards).toHaveLength(2);
    });
  });

  it('a disabled schedule never fires', async () => {
    await runInDurableObject(stubFor('sch-off'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schoff');
      await board.updateSchedule(s.id, { enabled: false });
      expect((await board.fireDueSchedules('2099-01-01T10:00:00.000Z')).fired).toEqual([]);
      expect((await board.getState()).cards).toHaveLength(0);
    });
  });

  it('a scheduled card is claimable — the grant fallback is not optional', async () => {
    await runInDurableObject(stubFor('sch-claimable'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schclaim');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      // Without createCardFromTrigger's queuedGrant fallback this is false under enforcement, and
      // every scheduled card would sit on the board forever. That is the whole reason this path
      // goes through the trigger helper rather than createCard.
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(true);
    });
  });

  // The discriminating version of the test above (board-triggers.test.ts:122's pattern): a card
  // born from `createCard` would carry `queuedGrant: null` regardless of the board's standing
  // grant, so this fails if `fireDueSchedules` is ever changed to call `createCard` instead of
  // `createCardFromTrigger` — no ENFORCE_CONTROL_PAIR and no principal mapping required to see it.
  it('stamps the board\'s standing grant onto a card a schedule fires', async () => {
    const GRANT = ['prn_0123456789abcdef0123'];
    await runInDurableObject(stubFor('sch-grant'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schgrant');
      await board.setGithubConfig({ triggerGrant: GRANT });
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      expect((await board.getState()).cards[0]!.queuedGrant).toEqual(GRANT);
    });
  });

  it('a schedule whose stage no longer exists still creates the card, and says so on the event log', async () => {
    await runInDurableObject(stubFor('sch-stagegone'), async (board: BoardDO) => {
      const withReview: BoardInit['stages'] = [
        ...STAGES,
        { key: 'review', name: 'Review', order: 1, ownerKind: 'capability', owner: 'writing' },
      ];
      await board.init({ id: 'brd_stagegone', tenantId: 'tnt_a', name: 'SG', stages: withReview });
      const r = await board.createSchedule({
        title: 'Sweep the logs',
        rule: 'daily at 09:00',
        timezone: 'UTC',
        overlap: 'skip',
        createdBy: 'usr_a',
        stageKey: 'review',
      });
      if (!r.ok) throw new Error(r.message);

      // The stage the schedule targets is removed after the schedule was written — `setStages`
      // only refuses to remove a stage still holding cards, and no card has reached "review" yet.
      const removed = await board.setStages([withReview[0]!]);
      if (!removed.ok) throw new Error(removed.message);

      const result = await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      expect(result.fired).toEqual([r.value.id]);

      const cards = (await board.getState()).cards;
      expect(cards).toHaveLength(1); // still created, despite the dropped routing

      const events = await board.getEvents(50);
      expect(events.some((e) => e.type === 'schedule.stage_failed')).toBe(true);
    });
  });

  // Important 2 (whole-branch review, Phase 2 fix wave): `next_fire_at` used to advance by
  // `nextFireAt(rule, tz, nowIso)` — pure addition from the SWEEP instant, which is always a
  // little after the instant that was actually due. Every tick's lateness got baked into the
  // phase forever, so `every 5 minutes` drifted into "every 5 or 10, unpredictably". The pure-math
  // proof lives in `recurrence.test.ts`; these two exercise the same fix through the DO's own
  // `fireDueSchedules`, which is what a real cron tick actually calls.
  it('keeps an interval schedule on phase across repeated slightly-late fires, end to end', async () => {
    await runInDurableObject(stubFor('sch-interval-phase'), async (board: BoardDO) => {
      const r = await boardWithSchedule(board, 'schintphase', {
        rule: 'every 5 minutes',
        overlap: 'allow', // so three fires in a row each mint a card rather than skipping
      });
      const first = new Date(r.nextFireAt).getTime();

      // Fire three times, each observed a little late relative to the schedule's OWN due instant
      // — not relative to wall-clock "now", which would make a real-time test fragile.
      let dueAt = first;
      for (const lateMs of [120, 340, 90]) {
        const nowIso = new Date(dueAt + lateMs).toISOString();
        // eslint-disable-next-line no-await-in-loop -- sequential ticks are the point being tested
        await board.fireDueSchedules(nowIso);
        dueAt += 5 * 60000; // the next due instant, on the ORIGINAL phase
      }

      const after = (await board.listSchedules())[0]!;
      // Exactly on phase: three 5-minute steps past the first fire time, to the millisecond — not
      // "first fire + the sum of every tick's lateness", which is what firing off `nowIso` each
      // time (the pre-fix behaviour) would produce.
      expect(after.nextFireAt).toBe(new Date(first + 3 * 5 * 60000).toISOString());
      expect((await board.getState()).cards).toHaveLength(3);
    });
  });

  it('an interval schedule fired far past due — a cron outage — still produces exactly one card, and does not immediately re-fire', async () => {
    await runInDurableObject(stubFor('sch-interval-collapse'), async (board: BoardDO) => {
      const r = await boardWithSchedule(board, 'schintcollapse', { rule: 'every 5 minutes' });

      // Years past the schedule's own first fire time — the same shape a cron that was down for a
      // long stretch (or a schedule nobody looked at) leaves behind. Before the fix this loop
      // shape ("collapse a missed week into one card") lived only in `nextFireAt`'s single
      // addition, which happened to also collapse correctly; the drift bug was orthogonal to it.
      // What this proves is that `advanceFireTime` did not reintroduce a replay-every-step bug
      // while fixing the drift.
      const result = await board.fireDueSchedules('2099-01-01T10:00:03.000Z');
      expect(result.fired).toEqual([r.id]);
      expect((await board.getState()).cards).toHaveLength(1);

      // And `next_fire_at` landed strictly after that sweep instant — one 5-minute step past the
      // stale value, not still-due — so the very next tick does not fire again immediately.
      const again = await board.fireDueSchedules('2099-01-01T10:00:04.000Z');
      expect(again.fired).toEqual([]);
      expect((await board.getState()).cards).toHaveLength(1);
    });
  });

  // Minor 5 (whole-branch review): `updateCard`'s Result was discarded here, four lines after the
  // fix that stopped discarding `moveCard`'s. Its only realistic failures (`NOT_INITIALIZED`,
  // `CARD_NOT_FOUND`) cannot happen on this path today, so this proves the CHECK exists — via
  // fault injection, the same device the `sweepBoard` isolation test uses, since there is no
  // data-driven way to make this particular call fail for real.
  it('reports it, rather than discarding it, when the priority/labels update after firing fails', async () => {
    await runInDurableObject(stubFor('sch-update-card-failed'), async (board: BoardDO) => {
      const r = await boardWithSchedule(board, 'schupdatefail', { priority: 5 });

      (board as unknown as { updateCard: (...args: unknown[]) => Promise<{ ok: boolean; code?: string }> }).updateCard =
        async () => ({ ok: false, code: 'CARD_NOT_FOUND' });

      const result = await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      // The card still exists and firing is still reported as successful — a dropped
      // priority/labels update does not mean the card itself failed to mint.
      expect(result.fired).toEqual([r.id]);

      const events = await board.getEvents(50);
      expect(events.some((e) => e.type === 'schedule.card_update_failed')).toBe(true);
    });
  });

  // Minor 6 (whole-branch review): the one state whose treatment differs between
  // `scheduleInstanceOpen` (all four terminal states closed) and Phase 3's coming blocker rule
  // (only completed/canceled resolved) had no test — precisely the case a later "unification"
  // would break without anyone noticing.
  it('fires again once the previous instance FAILED, not only when it completed', async () => {
    await runInDurableObject(stubFor('sch-resume-after-fail'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schresumefail');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      const [card] = (await board.getState()).cards;

      // `scheduleInstanceOpen` treats a FAILED previous instance as CLOSED — deliberately
      // different from Phase 3's coming blocker rule, where only completed/canceled resolve a
      // dependency and a failed one must keep blocking. Nothing in today's application drives a
      // card to the literal state 'failed' through a public verb: `fail()` is a RUN-level
      // retry/circuit-breaker (it leaves the card 'submitted' or, past the retry limit,
      // 'input-required' — never 'failed'), and per the contract's state machine 'failed' is only
      // ever produced by an `error` activity, which `postActivity` does not currently apply to the
      // card's own state. So the precondition is set directly here, the same column
      // `scheduleInstanceOpen`'s own SQL reads — this test is about that helper's branch, not
      // about how a card gets there.
      (board as unknown as { sql: { exec: (q: string, ...p: unknown[]) => unknown } }).sql.exec(
        `UPDATE cards SET state = 'failed' WHERE id = ?`,
        card!.id,
      );

      const again = await board.fireDueSchedules('2099-01-03T10:00:00.000Z');
      expect(again.fired).toHaveLength(1);
      expect((await board.getState()).cards).toHaveLength(2);
    });
  });
});

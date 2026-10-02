/**
 * Grouping a card's activity by the run that produced it.
 *
 * A published Press card carried 366 activities in one flat list — 18,806px of scroll against a
 * 900px viewport, about twenty-one screens. 361 of those rows were tool calls and 5 were anything
 * the agent said. The five separate runs behind them (brief, draft, verify, and two publish
 * attempts) were indistinguishable, even though `runId` is present on every single row.
 *
 * These hold the grouping to using the data that was already on the wire.
 */
import { describe, it, expect } from 'vitest';
import { groupActivities, isNarrative, visibleActivities } from './activity-groups';
import type { Activity, Attempt } from './api';

const act = (seq: number, runId: string, type = 'action', extra: Partial<Activity> = {}): Activity => ({
  seq,
  runId,
  type,
  ts: `2026-09-28T17:${String(40 + seq).padStart(2, '0')}:00Z`,
  body: null,
  action: type === 'action' ? 'read_file' : null,
  parameter: null,
  result: null,
  signal: null,
  ...extra,
});

const attempt = (runId: string, stageKey: string, outcome = 'completed'): Attempt => ({
  runId,
  stageKey,
  agentId: 'agt_1',
  status: 'ended',
  outcome,
  costUsd: 0,
  model: null,
  profileKey: null,
  // Per-run handoff and failure reason (spec 2026-10-02-a-card-remembers-its-stages). Null here:
  // this file is about GROUPING the stream, and how a run ended is `stage-account.ts`'s subject.
  handoff: null,
  failureReason: null,
});

describe('groupActivities', () => {
  it('splits one stream into a group per run, in the order they ran', () => {
    const groups = groupActivities(
      [act(1, 'run_a'), act(2, 'run_a'), act(3, 'run_b')],
      [attempt('run_a', 'brief'), attempt('run_b', 'draft')],
    );
    expect(groups.map((g) => g.stageKey)).toEqual(['brief', 'draft']);
    expect(groups[0]!.activities).toHaveLength(2);
  });

  it('carries the stage, agent and outcome from the attempt, so a group can be labelled', () => {
    const [g] = groupActivities([act(1, 'run_a')], [attempt('run_a', 'verify', 'completed')]);
    expect(g).toMatchObject({ runId: 'run_a', stageKey: 'verify', agentId: 'agt_1', outcome: 'completed' });
  });

  it('keeps activities whose run has no attempt rather than dropping them', () => {
    // An attempt list can lag the activity stream. Dropping the rows would silently hide work,
    // which is the failure this whole change exists to fix.
    const groups = groupActivities([act(1, 'run_orphan')], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.stageKey).toBeNull();
    expect(groups[0]!.activities).toHaveLength(1);
  });

  it('counts what is in each group, so a collapsed one can still say what it holds', () => {
    const [g] = groupActivities(
      [act(1, 'r'), act(2, 'r'), act(3, 'r', 'response', { body: 'Done.' }), act(4, 'r', 'error', { body: 'Boom' })],
      [attempt('r', 'draft')],
    );
    expect(g.counts).toMatchObject({ total: 4, action: 2, response: 1, error: 1 });
  });

  it('separates two runs of the SAME stage, because a retry is not the first attempt', () => {
    // The publish stage ran twice on the card that prompted this: the first refused and the
    // second shipped. Collapsing them into one section would hide exactly that.
    const groups = groupActivities(
      [act(1, 'run_1'), act(2, 'run_2')],
      [attempt('run_1', 'publish'), attempt('run_2', 'publish')],
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.stageKey === 'publish')).toBe(true);
  });

  it('returns nothing for nothing', () => {
    expect(groupActivities([], [])).toEqual([]);
  });
});

describe('isNarrative', () => {
  it('keeps what the agent said, and what went wrong', () => {
    expect(isNarrative(act(1, 'r', 'response', { body: 'Wrote the brief.' }))).toBe(true);
    expect(isNarrative(act(2, 'r', 'error', { body: 'failed' }))).toBe(true);
    expect(isNarrative(act(3, 'r', 'elicitation', { body: 'Which one?' }))).toBe(true);
    expect(isNarrative(act(4, 'r', 'thought', { body: 'considering' }))).toBe(true);
  });

  it('drops the tool calls, which are 361 of 366 rows on a real card', () => {
    expect(isNarrative(act(5, 'r', 'action'))).toBe(false);
  });
});

describe('visibleActivities — the run that is all tool calls', () => {
  const narrative = (a: { kind: string }) => a.kind === 'say';

  it('shows tool calls when there is no narrative to show instead', () => {
    // The live case: 67 activities, none narrative. The old behaviour rendered an empty panel
    // beneath a heading reading "67 events".
    const all = [{ kind: 'tool' }, { kind: 'tool' }, { kind: 'tool' }];
    const { rows, shownBecauseNoNarrative } = visibleActivities(all, narrative, false);
    expect(rows).toHaveLength(3);
    expect(shownBecauseNoNarrative).toBe(true);
  });

  it('still filters when the run has something to say', () => {
    const all = [{ kind: 'tool' }, { kind: 'say' }, { kind: 'tool' }];
    const { rows, shownBecauseNoNarrative } = visibleActivities(all, narrative, false);
    expect(rows).toEqual([{ kind: 'say' }]);
    expect(shownBecauseNoNarrative).toBe(false);
  });

  it('shows everything when the reader asked for everything', () => {
    const all = [{ kind: 'tool' }, { kind: 'say' }];
    expect(visibleActivities(all, narrative, true).rows).toHaveLength(2);
  });

  it('an empty run is empty, and does not claim it was hiding anything', () => {
    const { rows, shownBecauseNoNarrative } = visibleActivities([], narrative, false);
    expect(rows).toEqual([]);
    expect(shownBecauseNoNarrative).toBe(false);
  });
});

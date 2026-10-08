import { describe, expect, it } from 'vitest';
import { stageAccount } from './stage-account';

/**
 * A card's account, stage by stage.
 *
 * The drawer already groups activities by run. What it could not show was how each run ENDED — the
 * handoff lived in one column on the card, overwritten at every stage, and the failure reason went to
 * a human's notification and nowhere a reader could find it. So a card worked at three stages showed
 * three lists of actions and the last line of the story.
 */
const attempt = (over: Record<string, unknown> = {}) =>
  ({
    runId: 'run_1',
    agentId: 'agt_ulrich',
    stageKey: 'audit',
    status: 'ended',
    outcome: 'completed',
    costUsd: 0.5,
    model: 'claude-opus-5',
    profileKey: null,
    handoff: { summary: 'audit found three issues' },
    failureReason: null,
    ...over,
  }) as never;

const ref = (over: Record<string, unknown> = {}) =>
  ({ id: 'ref_1', cardId: 'card_1', url: 'https://x.y/1', title: 'Evidence', runId: 'run_1', addedBy: 'agent', ...over }) as never;

describe('stageAccount', () => {
  it('reads oldest first, so a card is a story rather than a stack (S1)', () => {
    const got = stageAccount(
      [attempt({ runId: 'run_1', stageKey: 'audit' }), attempt({ runId: 'run_2', stageKey: 'measure' })],
      [],
    );
    expect(got.map((s) => s.stageKey)).toEqual(['audit', 'measure']);
  });

  it('shows how a run ENDED — a handoff, or a failure, never both (S2)', () => {
    const [done, failed] = stageAccount(
      [
        attempt({ runId: 'run_1', outcome: 'completed' }),
        attempt({ runId: 'run_2', outcome: 'crashed', handoff: null, failureReason: 'Chrome exited early' }),
      ],
      [],
    );
    expect(done!.ended).toBe('completed');
    expect(done!.handoff).toEqual({ summary: 'audit found three issues' });
    expect(done!.failureReason).toBeNull();

    expect(failed!.ended).toBe('failed');
    expect(failed!.failureReason).toBe('Chrome exited early');
    expect(failed!.handoff).toBeNull();
  });

  it('says a run is still OPEN rather than guessing how it ended', () => {
    // A live run has no outcome yet. Calling that "failed" would mark working work as broken, and
    // calling it "completed" would be worse.
    const [open] = stageAccount([attempt({ status: 'open', outcome: null, handoff: null })], []);
    expect(open!.ended).toBe('open');
  });

  it('puts each reference under the run that attached it (S3)', () => {
    const got = stageAccount(
      [attempt({ runId: 'run_1' }), attempt({ runId: 'run_2', stageKey: 'measure' })],
      [ref({ id: 'ref_1', runId: 'run_1' }), ref({ id: 'ref_2', runId: 'run_2' }), ref({ id: 'ref_3', runId: null })],
    );
    expect(got[0]!.references.map((r) => r.id)).toEqual(['ref_1']);
    expect(got[1]!.references.map((r) => r.id)).toEqual(['ref_2']);
  });

  it('never attributes a HUMAN\'s reference to a stage (S3)', () => {
    // `runId: null` means a person attached it, or it predates the column. Either way it belongs to
    // the card, not to somebody's run — inventing an owner is the one thing worse than none.
    const got = stageAccount([attempt()], [ref({ id: 'ref_human', runId: null })]);
    expect(got[0]!.references).toEqual([]);
  });

  it('keeps two attempts at ONE stage as two entries (S4)', () => {
    // A retry is its own attempt with its own story. Merging them would hide that the first one
    // failed, which is the single most useful thing on the card.
    const got = stageAccount(
      [
        attempt({ runId: 'run_1', outcome: 'crashed', handoff: null, failureReason: 'transient' }),
        attempt({ runId: 'run_2', outcome: 'completed' }),
      ],
      [],
    );
    expect(got).toHaveLength(2);
    expect(got.map((s) => s.stageKey)).toEqual(['audit', 'audit']);
    expect(got[0]!.ended).toBe('failed');
    expect(got[1]!.ended).toBe('completed');
    // And the second is marked a retry, so a reader does not read two stages where there was one.
    expect(got[0]!.attemptOfStage).toBe(1);
    expect(got[1]!.attemptOfStage).toBe(2);
  });

  it('renders a card from before the change without inventing anything (S5)', () => {
    const got = stageAccount([attempt({ handoff: null, failureReason: null, outcome: 'completed' })], []);
    expect(got[0]!.handoff).toBeNull();
    expect(got[0]!.failureReason).toBeNull();
    expect(got[0]!.ended).toBe('completed');
  });
});

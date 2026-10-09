import { describe, it, expect } from 'vitest';
import {
  StageOutcome,
  outcomeInputError,
  returnStageError,
  routeOutcome,
} from '../src/outcome';
import { CompleteInput } from '../src/verbs';
import { Stage } from '../src/entities';

/**
 * How a finished turn says what it found.
 *
 * On 2026-10-09 an `integrate` run handed off `verdict: "unsafe — do not ship"` and the card moved
 * forward anyway: `complete` meant "advance", whatever the handoff said, and the only thing that
 * stopped the card was a person at the next gate. The same day an agent that needed a person to
 * approve a device sign-in ended its turn with the link, and the board read it as a finished
 * handoff missing a field, refused it twice and parked the card as a broken handoff.
 *
 * Both are the same missing word: what KIND of finish this is. Free text cannot carry it — the
 * verdict above was perfectly clear to a person and invisible to the board — so it is a field.
 */

const JUDGE = { key: 'integrate', returnStage: 'fix' };
const PLAIN = { key: 'build' };

describe('the outcome vocabulary', () => {
  it('is exactly pass, changes-needed and needs-person', () => {
    expect(StageOutcome.options).toEqual(['pass', 'changes-needed', 'needs-person']);
  });

  it('rides on complete beside the handoff, and is optional so every existing caller is unchanged', () => {
    expect(CompleteInput.safeParse({ runId: 'run_abc123', leaseEpoch: 0 }).success).toBe(true);
    const r = CompleteInput.safeParse({
      runId: 'run_abc123',
      leaseEpoch: 0,
      outcome: 'changes-needed',
      findings: 'the migration drops a column the API still reads',
    });
    expect(r.success).toBe(true);
    expect(CompleteInput.safeParse({ runId: 'run_abc123', leaseEpoch: 0, outcome: 'unsafe' }).success).toBe(false);
  });

  it('a stage may name where a failing verdict sends the card', () => {
    const s = Stage.parse({ key: 'integrate', name: 'Integrate', order: 2, ownerKind: 'capability', returnStage: 'fix' });
    expect(s.returnStage).toBe('fix');
  });
});

describe('what each outcome must carry', () => {
  it('changes-needed needs findings: a return that does not say what to change sends the fixer in blind', () => {
    expect(outcomeInputError({ outcome: 'changes-needed' })).toMatch(/findings/);
    expect(outcomeInputError({ outcome: 'changes-needed', findings: '   ' })).toMatch(/findings/);
    expect(outcomeInputError({ outcome: 'changes-needed', findings: 'tests fail on arm64' })).toBeNull();
  });

  it('needs-person needs the question, because a person cannot answer a card that asks nothing', () => {
    expect(outcomeInputError({ outcome: 'needs-person' })).toMatch(/question/);
    expect(outcomeInputError({ outcome: 'needs-person', question: 'Approve the device sign-in, then reply done.' })).toBeNull();
  });

  it('a url, when given, must be one', () => {
    expect(outcomeInputError({ outcome: 'needs-person', question: 'Approve it', url: 'not a url' })).toMatch(/url/);
    expect(outcomeInputError({ outcome: 'needs-person', question: 'Approve it', url: 'https://login.example/device' })).toBeNull();
  });

  it('pass and no outcome carry nothing extra', () => {
    expect(outcomeInputError({ outcome: 'pass' })).toBeNull();
    expect(outcomeInputError({})).toBeNull();
  });
});

describe('where a finished turn sends the card', () => {
  const room = { returnsSoFar: 0, limit: 2 };

  it('no outcome on a stage that judges nothing advances, exactly as before this existed', () => {
    expect(routeOutcome(PLAIN, {}, room)).toEqual({ kind: 'advance' });
    expect(routeOutcome(PLAIN, { outcome: 'pass' }, room)).toEqual({ kind: 'advance' });
  });

  it('a failing verdict returns the card to the stage the judge names', () => {
    expect(routeOutcome(JUDGE, { outcome: 'changes-needed', findings: 'x' }, room)).toEqual({ kind: 'return', to: 'fix' });
  });

  it('a failing verdict on a stage with no return stage never advances: it parks for a person', () => {
    const r = routeOutcome(PLAIN, { outcome: 'changes-needed', findings: 'x' }, room);
    expect(r.kind).toBe('park');
  });

  it('the automatic returns are bounded: past the limit the card parks instead of looping', () => {
    expect(routeOutcome(JUDGE, { outcome: 'changes-needed', findings: 'x' }, { returnsSoFar: 1, limit: 2 })).toEqual({
      kind: 'return',
      to: 'fix',
    });
    const r = routeOutcome(JUDGE, { outcome: 'changes-needed', findings: 'x' }, { returnsSoFar: 2, limit: 2 });
    expect(r).toMatchObject({ kind: 'park', repeated: true });
  });

  it('a judging stage must say which way it went — silence there is refused, not read as a pass', () => {
    const r = routeOutcome(JUDGE, {}, room);
    expect(r.kind).toBe('refuse');
    expect((r as { reason: string }).reason).toMatch(/pass.*changes-needed/);
    expect(routeOutcome(JUDGE, { outcome: 'pass' }, room)).toEqual({ kind: 'advance' });
  });

  it('needs-person waits on a person wherever it is said', () => {
    expect(routeOutcome(JUDGE, { outcome: 'needs-person', question: 'q' }, room)).toEqual({ kind: 'wait' });
    expect(routeOutcome(PLAIN, { outcome: 'needs-person', question: 'q' }, room)).toEqual({ kind: 'wait' });
  });
});

describe('a return stage must be reachable and earlier', () => {
  const stages = [
    { key: 'fix', order: 0 },
    { key: 'integrate', order: 1, returnStage: 'fix' },
    { key: 'ship', order: 2 },
  ];

  it('accepts an earlier stage', () => {
    expect(returnStageError(stages[1]!, stages)).toBeNull();
  });

  it('refuses a stage that does not exist', () => {
    expect(returnStageError({ key: 'integrate', order: 1, returnStage: 'fxi' }, stages)).toMatch(/fxi/);
  });

  it('refuses itself and a later stage: a return goes back, or it is a move', () => {
    expect(returnStageError({ key: 'integrate', order: 1, returnStage: 'integrate' }, stages)).toMatch(/earlier/);
    expect(returnStageError({ key: 'integrate', order: 1, returnStage: 'ship' }, stages)).toMatch(/earlier/);
  });

  it('is silent when no return stage is declared', () => {
    expect(returnStageError({ key: 'ship', order: 2 }, stages)).toBeNull();
  });
});

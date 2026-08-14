import { describe, it, expect } from 'vitest';
import { ActivityEnvelope, PostActivityInput } from '../src';

const base = {
  runId: 'run_abc123',
  seq: 0,
  ts: '2026-06-20T10:00:00.000Z',
};

describe('ActivityEnvelope invariants (docs/04 §4)', () => {
  it('accepts a valid ephemeral thought', () => {
    const r = ActivityEnvelope.safeParse({ ...base, type: 'thought', ephemeral: true, body: 'thinking' });
    expect(r.success).toBe(true);
  });

  it('accepts a valid action with an action name', () => {
    const r = ActivityEnvelope.safeParse({ ...base, type: 'action', action: 'web.fetch', ephemeral: true });
    expect(r.success).toBe(true);
  });

  it('rejects an ephemeral response (only thought/action may be ephemeral)', () => {
    const r = ActivityEnvelope.safeParse({ ...base, type: 'response', ephemeral: true, body: 'done' });
    expect(r.success).toBe(false);
  });

  it('rejects an action without an action field', () => {
    const r = ActivityEnvelope.safeParse({ ...base, type: 'action' });
    expect(r.success).toBe(false);
  });

  it('rejects a response without a body', () => {
    const r = ActivityEnvelope.safeParse({ ...base, type: 'response' });
    expect(r.success).toBe(false);
  });

  it('defaults ephemeral to false', () => {
    const r = ActivityEnvelope.parse({ ...base, type: 'response', body: 'ok' });
    expect(r.ephemeral).toBe(false);
  });

  it('rejects a malformed runId', () => {
    const r = ActivityEnvelope.safeParse({ ...base, runId: 'nope', type: 'thought', body: 'x' });
    expect(r.success).toBe(false);
  });
});

/**
 * An elicitation's structured payload — the options a human picks from — travels in `parameter`,
 * which is the field the board actually reads and persists. `signalMetadata` was a second, parallel
 * carrier that nothing ever read: an agent that put its options there had them silently dropped, so
 * the question reached the human with no answers to choose. One carrier, not two.
 */
describe('an elicitation carries its options in `parameter` (docs/04 §4)', () => {
  const question = {
    ...base,
    type: 'elicitation' as const,
    body: 'May I run the test suite?',
    signal: 'select' as const,
  };
  const options = [
    { name: 'yes', title: 'Run the tests' },
    { name: 'no', title: 'Skip them' },
  ];

  it('keeps the options an agent sends in `parameter`', () => {
    const a = ActivityEnvelope.parse({ ...question, parameter: { options } });
    expect(a.parameter).toEqual({ options });
    const v = PostActivityInput.parse({ ...question, leaseEpoch: 1, parameter: { options } });
    expect(v.parameter).toEqual({ options });
  });

  it('has no `signalMetadata` field — the second carrier is gone, not merely unread', () => {
    const a = ActivityEnvelope.parse({ ...question, signalMetadata: { options } }) as Record<string, unknown>;
    expect('signalMetadata' in a).toBe(false);
    const v = PostActivityInput.parse({ ...question, leaseEpoch: 1, signalMetadata: { options } }) as Record<string, unknown>;
    expect('signalMetadata' in v).toBe(false);
  });
});

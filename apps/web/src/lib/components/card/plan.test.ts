import { describe, it, expect } from 'vitest';
import { normalisePlan, planRendersWhole } from './plan';

describe('normalisePlan', () => {
  it('reads a plan of plain strings as steps that are not done', () => {
    expect(normalisePlan(['Shape it', '  Build it  '])).toEqual([
      { text: 'Shape it', done: false },
      { text: 'Build it', done: false },
    ]);
  });

  it('reads the documented { t, done } shape', () => {
    expect(normalisePlan([{ t: 'Draft', done: true }, { t: 'Ship', done: false }])).toEqual([
      { text: 'Draft', done: true },
      { text: 'Ship', done: false },
    ]);
  });

  it.each(['text', 'step', 'title', 'label', 'name', 'description'])('reads the text from `%s`', (key) => {
    expect(normalisePlan([{ [key]: 'Do it' }])).toEqual([{ text: 'Do it', done: false }]);
  });

  it.each([
    [{ done: true }],
    [{ completed: true }],
    [{ checked: true }],
    [{ status: 'done' }],
    [{ status: 'complete' }],
    [{ status: 'Completed' }],
  ])('reads %o as done', (flag) => {
    expect(normalisePlan([{ text: 'x', ...flag }])).toEqual([{ text: 'x', done: true }]);
  });

  it('does not treat other statuses or truthy non-booleans as done', () => {
    expect(normalisePlan([{ text: 'a', status: 'in_progress' }, { text: 'b', done: 'yes' }, { text: 'c', completed: 1 }])).toEqual([
      { text: 'a', done: false },
      { text: 'b', done: false },
      { text: 'c', done: false },
    ]);
  });

  it('skips items with no text instead of drawing empty boxes', () => {
    expect(normalisePlan(['', '   ', { done: true }, { t: '' }, null, 7, ['nested'], 'Real step'])).toEqual([
      { text: 'Real step', done: false },
    ]);
  });

  it('returns null when nothing usable remains, or the plan is not a list', () => {
    expect(normalisePlan([])).toBeNull();
    expect(normalisePlan(['', { done: true }])).toBeNull();
    expect(normalisePlan(undefined)).toBeNull();
    expect(normalisePlan('one step')).toBeNull();
    expect(normalisePlan({ t: 'x' })).toBeNull();
  });
});

describe('planRendersWhole', () => {
  it('is true only when every item became a step', () => {
    expect(planRendersWhole(['a', { t: 'b', done: true }])).toBe(true);
    expect(planRendersWhole(['a', { done: true }])).toBe(false);
    expect(planRendersWhole([])).toBe(false);
    expect(planRendersWhole('a')).toBe(false);
  });
});

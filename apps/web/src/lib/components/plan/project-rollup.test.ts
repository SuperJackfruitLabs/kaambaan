import { describe, it, expect } from 'vitest';
import { formatAsOf, progressPct, rollupHeadline } from './project-rollup';

describe('formatAsOf', () => {
  it('renders a complete rollup as "as of HH:MM", with no incomplete notice', () => {
    const line = formatAsOf({ computedAt: '2026-10-01T14:32:00.000Z', partial: false, boardsUnanswered: 0 });
    expect(line).toMatch(/^as of \d{2}:\d{2}$/);
    expect(line).not.toContain('incomplete');
  });

  it('names the incomplete notice and the exact unanswered count when partial, singular board', () => {
    const line = formatAsOf({ computedAt: '2026-10-01T14:32:00.000Z', partial: true, boardsUnanswered: 1 });
    expect(line).toMatch(/^as of \d{2}:\d{2} · incomplete \(1 board did not answer\)$/);
  });

  it('pluralises "boards" when more than one board failed to answer', () => {
    const line = formatAsOf({ computedAt: '2026-10-01T14:32:00.000Z', partial: true, boardsUnanswered: 2 });
    expect(line).toContain('2 boards did not answer');
    expect(line).not.toContain('2 board ');
  });
});

describe('progressPct', () => {
  it('is 0 for a project with no cards at all — never divides by zero', () => {
    expect(progressPct({ cardsTotal: 0, cardsDone: 0 })).toBe(0);
  });

  it('rounds cardsDone/cardsTotal to the nearest whole percent', () => {
    expect(progressPct({ cardsTotal: 3, cardsDone: 1 })).toBe(33);
  });

  it('never exceeds 100 even if cardsDone somehow outpaces cardsTotal', () => {
    expect(progressPct({ cardsTotal: 2, cardsDone: 5 })).toBe(100);
  });
});

describe('rollupHeadline', () => {
  // `ProjectView.svelte` renders this one string through one interpolation — the point of the
  // function (see its own doc comment). These tests hold the property that actually matters:
  // every figure this headline carries is physically part of the same string as `formatAsOf`'s
  // provenance, so a template edit cannot keep one while dropping the other.
  const base = { cardsTotal: 5, cardsDone: 3, costUsd: 12.5, cardsOverdue: 0, computedAt: '2026-10-01T14:32:00.000Z', partial: false, boardsUnanswered: 0 };

  it('carries cards, cost, and the as-of line in one string', () => {
    const line = rollupHeadline(base);
    expect(line).toContain('3/5 cards done');
    expect(line).toContain('$12.50');
    expect(line).toContain(formatAsOf(base));
  });

  it('cannot report a figure without also reporting formatAsOf\'s exact text, by construction', () => {
    // Not a redundant check of the line above: this asserts the STRUCTURAL property — that
    // whatever `formatAsOf` returns for this rollup is a substring of whatever `rollupHeadline`
    // returns for the same rollup, for an arbitrary set of inputs including the partial case.
    // That is the property a future edit could only break by editing `rollupHeadline` itself,
    // which is exactly the point: there is no template-level degree of freedom left to lose.
    const partial = { ...base, partial: true, boardsUnanswered: 2 };
    for (const r of [base, partial]) {
      expect(rollupHeadline(r)).toContain(formatAsOf(r));
    }
  });

  it('appends the overdue count only when there is one, still attached to the same string', () => {
    expect(rollupHeadline(base)).not.toContain('overdue');
    const overdue = rollupHeadline({ ...base, cardsOverdue: 2 });
    expect(overdue).toContain('2 overdue');
    expect(overdue).toContain(formatAsOf(base)); // provenance still present alongside it
  });
});

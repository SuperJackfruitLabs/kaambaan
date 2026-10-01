import { describe, it, expect } from 'vitest';
import { formatAsOf, progressPct, rollupSegments } from './project-rollup';

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

describe('rollupSegments', () => {
  // `ProjectView.svelte` renders every element of this array through one `{#each}` — the point of
  // the function (see its own doc comment). These tests hold the property that actually matters:
  // a provenance segment is always present, carrying `formatAsOf`'s exact text, so a template
  // edit cannot keep the figures while dropping it without visibly filtering the loop.
  const base = { cardsTotal: 5, cardsDone: 3, costUsd: 12.5, cardsOverdue: 0, computedAt: '2026-10-01T14:32:00.000Z', partial: false, boardsUnanswered: 0 };

  it('returns a figure segment each for cards and cost, in that order', () => {
    const figures = rollupSegments(base).filter((s) => s.kind === 'figure');
    expect(figures.map((s) => s.text)).toEqual(['3/5 cards done', '$12.50']);
  });

  it('always returns exactly one provenance segment, carrying formatAsOf\'s exact text, for any input', () => {
    // Not a redundant check of the segment above: this asserts the STRUCTURAL property — that
    // for an arbitrary rollup, including the partial case (where provenance carries the
    // unanswered-board count rather than being omitted), there is always exactly one `provenance`
    // segment and its text always contains exactly what `formatAsOf` would say for that same
    // rollup. That is the property a future edit could only break by editing `rollupSegments`
    // itself, which is exactly the point: there is no template-level degree of freedom left to
    // drop it with.
    const partial = { ...base, partial: true, boardsUnanswered: 2 };
    for (const r of [base, partial]) {
      const provenance = rollupSegments(r).filter((s) => s.kind === 'provenance');
      expect(provenance).toHaveLength(1);
      expect(provenance[0]!.text).toContain(formatAsOf(r));
    }
  });

  it('places the provenance segment last, after both figures', () => {
    expect(rollupSegments(base).map((s) => s.kind)).toEqual(['figure', 'figure', 'provenance']);
  });

  it('folds the overdue count into the provenance segment, not a third figure, only when there is one', () => {
    const noOverdue = rollupSegments(base);
    expect(noOverdue.some((s) => s.text.includes('overdue'))).toBe(false);

    const withOverdue = rollupSegments({ ...base, cardsOverdue: 2 });
    expect(withOverdue).toHaveLength(3); // still cards, cost, provenance — not a fourth segment
    const provenance = withOverdue.find((s) => s.kind === 'provenance')!;
    expect(provenance.text).toContain('2 overdue');
    expect(provenance.text).toContain(formatAsOf(base)); // provenance still present alongside it
  });
});

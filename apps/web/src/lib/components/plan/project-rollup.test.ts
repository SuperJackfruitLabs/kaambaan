import { describe, it, expect } from 'vitest';
import { formatAsOf, progressPct } from './project-rollup';

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

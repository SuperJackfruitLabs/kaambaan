import { describe, it, expect } from 'vitest';
import { overdue } from './card-due';

describe('overdue', () => {
  it('is true for a past date on an unfinished card', () => {
    expect(overdue('2026-09-01', 'working', '2026-09-30')).toBe(true);
  });
  it('is false once the card is completed, however late', () => {
    expect(overdue('2026-09-01', 'completed', '2026-09-30')).toBe(false);
  });
  it('is false on the due date itself — a card is due at end of day', () => {
    expect(overdue('2026-09-30', 'working', '2026-09-30')).toBe(false);
  });
  it('is false with no due date', () => {
    expect(overdue(null, 'working', '2026-09-30')).toBe(false);
  });
});

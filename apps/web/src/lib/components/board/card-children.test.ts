import { describe, it, expect } from 'vitest';
import { childCounter, countChildren } from './card-children';

describe('countChildren', () => {
  it('counts cards whose parentCardId names this card', () => {
    const cards = [
      { parentCardId: 'parent' },
      { parentCardId: 'parent' },
      { parentCardId: null },
      { parentCardId: 'someone-else' },
    ];
    expect(countChildren(cards, 'parent')).toBe(2);
  });

  it('is zero for a card with no children', () => {
    expect(countChildren([{ parentCardId: null }], 'parent')).toBe(0);
  });
});

describe('childCounter', () => {
  it('is null when the card has no children at all — not "0/0"', () => {
    expect(childCounter(0, 0)).toBeNull();
  });

  it('pairs open (server-computed, respects resolved states) with total (counted from siblings)', () => {
    // A card with 5 children, 2 still open — the brief's own example.
    expect(childCounter(2, 5)).toEqual({ open: 2, total: 5 });
  });

  it('still renders when every child is resolved (0 open of N)', () => {
    expect(childCounter(0, 5)).toEqual({ open: 0, total: 5 });
  });
});

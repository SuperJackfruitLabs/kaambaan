import { describe, it, expect } from 'vitest';
import { childCounter, childCountsByParent } from './card-children';

describe('childCountsByParent', () => {
  it('counts every card once, by its own parentCardId, in a single pass — the Map a tile then does an O(1) lookup against', () => {
    const cards = [
      { id: 'c1', parentCardId: 'parent' },
      { id: 'c2', parentCardId: 'parent' },
      { id: 'c3', parentCardId: null },
      { id: 'c4', parentCardId: 'someone-else' },
    ];
    const counts = childCountsByParent(cards);
    expect(counts.get('parent')).toBe(2);
    expect(counts.get('someone-else')).toBe(1);
    expect(counts.has('c3')).toBe(false); // no card names c3 as a parent
  });

  it('gives an empty Map for a board with no parent/child edges at all', () => {
    expect(childCountsByParent([{ parentCardId: null }]).size).toBe(0);
  });

  it('a card absent from the Map means zero children — callers use `.get(id) ?? 0`, never assume presence', () => {
    const counts = childCountsByParent([{ parentCardId: null }]);
    expect(counts.get('c1')).toBeUndefined();
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

import { describe, it, expect } from 'vitest';
import { blockedCountInStage } from './board-counts';

describe('blockedCountInStage', () => {
  it('counts from blockedBy.length > 0, across the stage\'s cards — two blocked of five', () => {
    const cards = [
      { blockedBy: [{ cardId: 'a', title: 'A' }] },
      { blockedBy: [] },
      { blockedBy: [{ cardId: 'b', title: 'B' }] },
      { blockedBy: [] },
      { blockedBy: [] },
    ];
    expect(blockedCountInStage(cards)).toBe(2);
  });

  it('is zero when nothing in the stage is blocked', () => {
    expect(blockedCountInStage([{ blockedBy: [] }, { blockedBy: [] }])).toBe(0);
  });

  it('is zero for an empty stage', () => {
    expect(blockedCountInStage([])).toBe(0);
  });
});

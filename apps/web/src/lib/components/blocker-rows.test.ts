import { describe, it, expect } from 'vitest';
import { blockerRows } from './blocker-rows';

describe('blockerRows', () => {
  it('renders ⛔ and names the blocker for a same-board entry in Card.blockedBy', () => {
    const rows = blockerRows('card_c', [{ cardId: 'card_a', title: 'Fix the migration' }], [], () => null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.badge.glyph).toBe('⛔');
    expect(rows[0]!.title).toBe('Fix the migration');
    expect(rows[0]!.boardId).toBeNull();
  });

  it('renders ⚑ and NOT ⛔ for an advisory-only (cross-board) blocker', () => {
    const rows = blockerRows(
      'card_c',
      [], // nothing same-board — blockedBy is empty
      [{ kind: 'blocks', toCardId: 'card_c', fromCardId: 'card_x', fromBoardId: 'brd_2' }],
      (boardId) => (boardId === 'brd_2' ? 'Design board' : null),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.badge.glyph).toBe('⚑');
    expect(rows.some((r) => r.badge.glyph === '⛔')).toBe(false);
    expect(rows[0]!.boardId).toBe('brd_2');
  });

  it('keeps both kinds apart when a card has both an enforced and an advisory blocker', () => {
    const rows = blockerRows(
      'card_c',
      [{ cardId: 'card_a', title: 'Fix the migration' }],
      [{ kind: 'blocks', toCardId: 'card_c', fromCardId: 'card_x', fromBoardId: 'brd_2' }],
      () => 'Design board',
    );
    const glyphs = rows.map((r) => r.badge.glyph).sort();
    expect(glyphs).toEqual(['⚑', '⛔']);
  });

  it('ignores external links that do not point at this card, or are not `blocks`', () => {
    const rows = blockerRows(
      'card_c',
      [],
      [
        { kind: 'blocks', toCardId: 'someone-else', fromCardId: 'card_x', fromBoardId: 'brd_2' },
        { kind: 'relates', toCardId: 'card_c', fromCardId: 'card_y', fromBoardId: 'brd_2' },
      ],
      () => 'Design board',
    );
    expect(rows).toHaveLength(0);
  });
});

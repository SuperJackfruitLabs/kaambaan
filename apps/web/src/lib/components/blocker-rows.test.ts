import { describe, it, expect } from 'vitest';
import { blockerRows } from './blocker-rows';

describe('blockerRows', () => {
  it('renders ⛔ and names the blocker for a same-board entry in Card.blockedBy — untouched by the otherCardTitle/otherBoardName follow-up', () => {
    const rows = blockerRows('card_c', [{ cardId: 'card_a', title: 'Fix the migration' }], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.badge.glyph).toBe('⛔');
    expect(rows[0]!.title).toBe('Fix the migration');
    expect(rows[0]!.boardId).toBeNull();
    expect(rows[0]!.badge.tooltip).toBe('Blocked by Fix the migration — this card will not be claimed');
  });

  it('renders ⚑ and NOT ⛔ for an advisory-only (cross-board) blocker, with the resolved title and board in the tooltip', () => {
    const rows = blockerRows(
      'card_c',
      [], // nothing same-board — blockedBy is empty
      [
        {
          kind: 'blocks',
          toCardId: 'card_c',
          fromCardId: 'card_x',
          fromBoardId: 'brd_2',
          otherCardTitle: 'Fix the layout',
          otherBoardName: 'Design board',
        },
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.badge.glyph).toBe('⚑');
    expect(rows.some((r) => r.badge.glyph === '⛔')).toBe(false);
    expect(rows[0]!.boardId).toBe('brd_2');
    expect(rows[0]!.title).toBe('Fix the layout');
    expect(rows[0]!.badge.tooltip).toBe('Blocked by Fix the layout on Design board — not enforced across boards');
  });

  it('falls back to the card id when the title does not resolve, and the tooltip still reads as one sentence', () => {
    const rows = blockerRows(
      'card_c',
      [],
      [
        {
          kind: 'blocks',
          toCardId: 'card_c',
          fromCardId: 'card_x7f2',
          fromBoardId: 'brd_2',
          otherCardTitle: null, // the server could not resolve it — a real state, not an error
          otherBoardName: 'Design board',
        },
      ],
    );
    expect(rows[0]!.title).toBe('card_x7f2');
    expect(rows[0]!.badge.tooltip).toBe('Blocked by card_x7f2 on Design board — not enforced across boards');
    expect(rows[0]!.badge.tooltip).not.toContain('undefined');
    expect(rows[0]!.badge.tooltip).not.toContain('null');
  });

  it('falls back to the card id AND drops "on Board" coherently when neither resolves', () => {
    const rows = blockerRows(
      'card_c',
      [],
      [
        {
          kind: 'blocks',
          toCardId: 'card_c',
          fromCardId: 'card_x7f2',
          fromBoardId: 'brd_2',
          otherCardTitle: null,
          otherBoardName: null,
        },
      ],
    );
    expect(rows[0]!.title).toBe('card_x7f2');
    expect(rows[0]!.badge.tooltip).toBe('Blocked by card_x7f2 — not enforced across boards');
    expect(rows[0]!.badge.tooltip).not.toContain('  ');
  });

  it('keeps both kinds apart when a card has both an enforced and an advisory blocker', () => {
    const rows = blockerRows(
      'card_c',
      [{ cardId: 'card_a', title: 'Fix the migration' }],
      [
        {
          kind: 'blocks',
          toCardId: 'card_c',
          fromCardId: 'card_x',
          fromBoardId: 'brd_2',
          otherCardTitle: 'Fix the layout',
          otherBoardName: 'Design board',
        },
      ],
    );
    const glyphs = rows.map((r) => r.badge.glyph).sort();
    expect(glyphs).toEqual(['⚑', '⛔']);
  });

  it('ignores external links that do not point at this card, or are not `blocks`', () => {
    const rows = blockerRows(
      'card_c',
      [],
      [
        { kind: 'blocks', toCardId: 'someone-else', fromCardId: 'card_x', fromBoardId: 'brd_2', otherCardTitle: 'X', otherBoardName: 'Y' },
        { kind: 'relates', toCardId: 'card_c', fromCardId: 'card_y', fromBoardId: 'brd_2', otherCardTitle: 'Y', otherBoardName: 'Z' },
      ],
    );
    expect(rows).toHaveLength(0);
  });
});

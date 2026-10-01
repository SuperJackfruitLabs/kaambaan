import { describe, it, expect } from 'vitest';
import { enforcedBadge, advisoryBadge } from './card-blocked';

describe('enforcedBadge', () => {
  it('is null when nothing blocks the card', () => {
    expect(enforcedBadge([])).toBeNull();
  });

  it('renders ⛔ and names the blocker for a single unresolved same-board blocker', () => {
    const badge = enforcedBadge([{ cardId: 'card_a', title: 'Fix the migration' }]);
    expect(badge).not.toBeNull();
    expect(badge!.glyph).toBe('⛔');
    expect(badge!.label).toBe('Blocked');
    expect(badge!.tooltip).toBe('Blocked by Fix the migration — this card will not be claimed');
  });

  it('names the first blocker and counts the rest when there is more than one', () => {
    const badge = enforcedBadge([
      { cardId: 'card_a', title: 'Fix the migration' },
      { cardId: 'card_b', title: 'Write the doc' },
    ]);
    expect(badge!.tooltip).toBe('Blocked by Fix the migration and 1 other — this card will not be claimed');
  });
});

describe('advisoryBadge', () => {
  it('renders ⚑, never ⛔ — it is never confused with the enforced badge', () => {
    const badge = advisoryBadge('Fix the layout', 'Design board');
    expect(badge.glyph).toBe('⚑');
    expect(badge.glyph).not.toBe('⛔');
    expect(badge.label).toBe('Blocked (advisory)');
  });

  it('names the blocker and the board in the tooltip and says it is not enforced — the spec\'s own sentence', () => {
    const badge = advisoryBadge('Fix the layout', 'Design board');
    expect(badge.tooltip).toBe('Blocked by Fix the layout on Design board — not enforced across boards');
  });

  it('still reads as one coherent sentence when the board name cannot be resolved', () => {
    const badge = advisoryBadge('Fix the layout', null);
    expect(badge.tooltip).toBe('Blocked by Fix the layout — not enforced across boards');
    expect(badge.tooltip).not.toContain('undefined');
    expect(badge.tooltip).not.toContain('null');
    expect(badge.tooltip).not.toContain('  '); // no double space where "on Board" would have been
  });

  it('still reads as one coherent sentence when the title falls back to a card id', () => {
    // `buildLinkGroups` (link-groups.ts) is what actually falls back to the id when `otherCardTitle` is null — this
    // just proves `advisoryBadge` treats a card id exactly like any other title string, rather
    // than needing to know the difference.
    const badge = advisoryBadge('card_x7f2', 'Design board');
    expect(badge.tooltip).toBe('Blocked by card_x7f2 on Design board — not enforced across boards');
  });
});

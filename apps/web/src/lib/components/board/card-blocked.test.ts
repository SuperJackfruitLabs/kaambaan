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
    const badge = advisoryBadge('Design board');
    expect(badge.glyph).toBe('⚑');
    expect(badge.glyph).not.toBe('⛔');
    expect(badge.label).toBe('Blocked (advisory)');
  });

  it('names the board in the tooltip and says it is not enforced', () => {
    const badge = advisoryBadge('Design board');
    expect(badge.tooltip).toContain('Design board');
    expect(badge.tooltip).toContain('not enforced across boards');
  });

  it('still renders a valid tooltip when the board name cannot be resolved', () => {
    const badge = advisoryBadge(null);
    expect(badge.tooltip).not.toContain('undefined');
    expect(badge.tooltip).not.toContain('null');
    expect(badge.tooltip).toContain('not enforced across boards');
  });
});

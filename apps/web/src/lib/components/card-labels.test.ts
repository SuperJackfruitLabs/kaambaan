import { describe, it, expect } from 'vitest';
import { resolveCardLabelsForEdit } from './card-labels';

describe('resolveCardLabelsForEdit', () => {
  it('joins resolved names, comma-separated', () => {
    const byName = new Map([
      ['lbl_a', 'bug'],
      ['lbl_b', 'urgent'],
    ]);
    const r = resolveCardLabelsForEdit(['lbl_a', 'lbl_b'], byName);
    expect(r.text).toBe('bug, urgent');
    expect(r.blind).toBe(false);
  });

  it('is not blind for a card with no labels at all', () => {
    const r = resolveCardLabelsForEdit([], new Map());
    expect(r.text).toBe('');
    expect(r.blind).toBe(false);
  });

  it('is not blind when the catalogue resolves at least one of several ids', () => {
    const byName = new Map([['lbl_a', 'bug']]);
    const r = resolveCardLabelsForEdit(['lbl_a', 'lbl_stale'], byName);
    expect(r.text).toBe('bug');
    expect(r.blind).toBe(false);
  });

  /**
   * The wipe scenario (finding 2): a card carries label ids, but the catalogue resolved NONE of
   * them — stale (loaded only at board open, never refreshed) or failed to load (`listLabels`
   * swallows a non-ok response into `[]`). The editor must know it cannot see the labels, so the
   * caller can refuse to write `labelNames` and silently delete them.
   */
  it('is blind when the card carries labels but the catalogue resolves none of them', () => {
    const r = resolveCardLabelsForEdit(['lbl_a', 'lbl_b'], new Map());
    expect(r.text).toBe('');
    expect(r.blind).toBe(true);
  });
});

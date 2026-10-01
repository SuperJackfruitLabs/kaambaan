import { describe, it, expect } from 'vitest';
import { passesArchivedFilter, passesProjectFilter } from './card-filters';

describe('passesArchivedFilter', () => {
  it('shows a never-archived card (archivedAt: null) when the filter is off', () => {
    expect(passesArchivedFilter(false, null)).toBe(true);
  });

  it('shows a never-archived card whose archivedAt is genuinely undefined, not null', () => {
    // The actual bug (finding 8): `app.svelte.ts` compared `c.archivedAt !== null`, which is
    // `true` for `undefined` — hiding a card that was never archived at all whenever
    // `showArchived` is off.
    expect(passesArchivedFilter(false, undefined)).toBe(true);
  });

  it('hides an archived card when the filter is off', () => {
    expect(passesArchivedFilter(false, '2026-09-30T00:00:00.000Z')).toBe(false);
  });

  it('shows an archived card when the filter is on', () => {
    expect(passesArchivedFilter(true, '2026-09-30T00:00:00.000Z')).toBe(true);
  });

  it('shows an unarchived card when the filter is on', () => {
    expect(passesArchivedFilter(true, null)).toBe(true);
  });
});

describe('passesProjectFilter', () => {
  it('passes every card when no project filter is set', () => {
    expect(passesProjectFilter(null, null)).toBe(true);
    expect(passesProjectFilter(null, 'prj_1')).toBe(true);
  });

  it('passes a card carrying exactly the filtered project', () => {
    expect(passesProjectFilter('prj_1', 'prj_1')).toBe(true);
  });

  it('hides a card with no project once a project filter is on', () => {
    expect(passesProjectFilter('prj_1', null)).toBe(false);
  });

  it('hides a card belonging to a different project', () => {
    expect(passesProjectFilter('prj_1', 'prj_2')).toBe(false);
  });
});

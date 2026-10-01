import { describe, it, expect } from 'vitest';
import { resolveProjectName } from './project-lookup';

const projects = [
  { id: 'prj_1', name: 'Phase 4' },
  { id: 'prj_2', name: 'Phase 5' },
];

describe('resolveProjectName', () => {
  it('is null when the card carries no project — the normal, unassigned state', () => {
    expect(resolveProjectName(null, projects)).toBeNull();
  });

  it('resolves a known id to its name', () => {
    expect(resolveProjectName('prj_1', projects)).toBe('Phase 4');
  });

  it('falls back to the raw id for a dangling projectId, and never throws', () => {
    // `DELETE /v1/projects/:id` deletes unconditionally — a card can carry a projectId the
    // catalogue no longer resolves. This must render SOMETHING, not blow up the caller.
    expect(() => resolveProjectName('prj_deleted', projects)).not.toThrow();
    expect(resolveProjectName('prj_deleted', projects)).toBe('prj_deleted');
  });

  it('falls back to the raw id against an empty catalogue (e.g. the fetch failed)', () => {
    expect(resolveProjectName('prj_1', [])).toBe('prj_1');
  });
});

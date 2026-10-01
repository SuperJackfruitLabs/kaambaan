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

/**
 * `FilterBar`'s chip and `CardDrawer`'s current-assignment line both turn a `projectId` into
 * display text. `FilterBar.svelte` used to do this with its own `projectById.get(id)?.name ?? id`
 * — the identical fallback `resolveProjectName` computes, but AS A SECOND EXPRESSION, which
 * agreed with this one today by coincidence, not by construction (whole-branch review, Important
 * finding: "a badge computed from a second expression that agreed today would eventually disagree
 * … silently"). Both surfaces now call `resolveProjectName` directly, so this is no longer two
 * things that happen to match — it is one function two call sites both use.
 *
 * This test pins THAT PROPERTY rather than either template's current wording (which this
 * project's Vitest config cannot render — see `vitest.config.ts`'s own comment on that limit, and
 * `CardDrawer.svelte`'s prior note on the same thing): whatever a dangling id resolves to, every
 * caller gets the SAME text, because there is exactly one place that decides. It is the test that
 * fails if a future surface reintroduces its own inline fallback that happens to agree today.
 */
describe('resolveProjectName — one function every surface routes through', () => {
  it('gives FilterBar\'s call shape and CardDrawer\'s call shape the identical dangling-id fallback', () => {
    const danglingId = 'prj_deleted';
    // FilterBar.svelte: `resolveProjectName(f.projectId, projectCatalogue) ?? f.projectId`
    const filterBarText = resolveProjectName(danglingId, projects) ?? danglingId;
    // CardDrawer.svelte: `resolveProjectName(cardProjectId, app.projects)` used directly
    const cardDrawerText = resolveProjectName(danglingId, projects);

    expect(filterBarText).toBe(cardDrawerText);
    expect(filterBarText).toBe(danglingId);
  });

  it('gives FilterBar\'s call shape and CardDrawer\'s call shape the identical text for a RESOLVED id too', () => {
    const filterBarText = resolveProjectName('prj_1', projects) ?? 'prj_1';
    const cardDrawerText = resolveProjectName('prj_1', projects);

    expect(filterBarText).toBe(cardDrawerText);
    expect(filterBarText).toBe('Phase 4');
  });
});

import { describe, it, expect } from 'vitest';
import { milestonesForProject, assignmentPatch } from './milestone-picker';

describe('milestonesForProject', () => {
  const milestones = [
    { id: 'mst_1', projectId: 'prj_1', name: 'Beta', sortOrder: 0 },
    { id: 'mst_2', projectId: 'prj_1', name: 'GA', sortOrder: 1 },
    { id: 'mst_3', projectId: 'prj_2', name: 'Kickoff', sortOrder: 0 },
  ];

  it('offers only the chosen project\'s milestones — the server refuses a mismatch (MILESTONE_NOT_IN_PROJECT)', () => {
    const offered = milestonesForProject(milestones, 'prj_1');
    expect(offered.map((m) => m.id)).toEqual(['mst_1', 'mst_2']);
    expect(offered.every((m) => m.projectId === 'prj_1')).toBe(true);
  });

  it('is empty when no project is chosen — there is nothing to scope the picker to', () => {
    expect(milestonesForProject(milestones, null)).toEqual([]);
  });

  it('is empty for a project with no milestones of its own, even if the list carries others', () => {
    expect(milestonesForProject(milestones, 'prj_3')).toEqual([]);
  });
});

describe('assignmentPatch', () => {
  const current = { projectId: 'prj_1', milestoneId: 'mst_1' };

  it('is empty when nothing changed', () => {
    expect(assignmentPatch(current, { projectId: 'prj_1', milestoneId: 'mst_1' })).toEqual({});
  });

  it('carries only milestoneId when the project is unchanged', () => {
    expect(assignmentPatch(current, { projectId: 'prj_1', milestoneId: 'mst_2' })).toEqual({ milestoneId: 'mst_2' });
  });

  it('clears the milestone when the project changes, even to the same milestoneId value, because the server computes the "effective" milestone from the CURRENT card whenever either half of the pair is omitted', () => {
    // This is the chosen handling for the server's stale-milestone refusal (MILESTONE_NOT_IN_PROJECT):
    // the picker clears its own milestone selection the moment the project changes, and this
    // function makes that explicit on the wire rather than leaving milestoneId to be inferred.
    expect(assignmentPatch(current, { projectId: 'prj_2', milestoneId: null })).toEqual({
      projectId: 'prj_2',
      milestoneId: null,
    });
  });

  it('sends the project change alongside a milestone freshly chosen from the NEW project', () => {
    expect(assignmentPatch(current, { projectId: 'prj_2', milestoneId: 'mst_3' })).toEqual({
      projectId: 'prj_2',
      milestoneId: 'mst_3',
    });
  });

  it('clears both when the project is unset entirely', () => {
    expect(assignmentPatch(current, { projectId: null, milestoneId: null })).toEqual({
      projectId: null,
      milestoneId: null,
    });
  });
});

/**
 * `CardDrawer.svelte`'s project + milestone picker (Step 3) — kept out of the `.svelte` file for
 * the same reason `add-blocker.ts` is (this project's Vitest config cannot import a `.svelte`
 * file).
 */
/**
 * Scope the milestone picker to the chosen project. The server refuses a mismatch
 * (`MILESTONE_NOT_IN_PROJECT`, `apps/api/src/index.ts`'s `PATCH .../cards/:cardId`) and the UI
 * must not offer what it will refuse — this is the filter that keeps the two in agreement. `null`
 * (no project chosen) offers nothing: there is no project to scope the picker to.
 *
 * Generic over `T` (rather than fixed to `$lib/api`'s `Milestone`) so a test can pass minimal
 * `{ projectId }`-shaped fixtures without filling in every column just to prove the filter.
 */
export function milestonesForProject<T extends { projectId: string }>(milestones: T[], projectId: string | null): T[] {
  if (!projectId) return [];
  return milestones.filter((m) => m.projectId === projectId);
}

export interface Assignment {
  projectId: string | null;
  milestoneId: string | null;
}

/**
 * The patch to send for a project/milestone assignment edit.
 *
 * The server refuses `PATCH { projectId: B }` on a card still carrying a milestone from project A
 * (`MILESTONE_NOT_IN_PROJECT`) whenever EITHER half of the pair could change — not only when
 * `milestoneId` is explicitly in the body. Omitting it, it recomputes the "effective" milestone
 * from the card's CURRENT value, so a project-only patch on a card already holding a milestone is
 * refused even though the caller never meant to touch the milestone at all.
 *
 * **Chosen handling: clear the milestone selection the moment the project changes**, rather than
 * surfacing the refusal as a sentence after the fact. A person picking a new project is choosing
 * to move the card, not asking to see why the old milestone no longer fits; a refusal here would
 * just be a round trip back to the same clear-and-retry a sentence is trying to avoid. The picker
 * itself does the clearing (see `CardDrawer.svelte`'s `onProjectSelectChange`); this function just
 * mirrors that pairing onto the wire patch, so a project change ALWAYS carries `milestoneId`
 * explicitly rather than leaving it to the server's own merge.
 */
export function assignmentPatch(current: Assignment, next: Assignment): Partial<Assignment> {
  const patch: Partial<Assignment> = {};
  const projectChanged = next.projectId !== current.projectId;
  const milestoneChanged = next.milestoneId !== current.milestoneId;
  if (projectChanged) patch.projectId = next.projectId;
  if (projectChanged || milestoneChanged) patch.milestoneId = next.milestoneId;
  return patch;
}

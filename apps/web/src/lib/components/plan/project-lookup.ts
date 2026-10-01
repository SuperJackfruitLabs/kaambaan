/**
 * Resolving a card's `projectId` to a name — the one place that has to hold the fact that an
 * unresolved id is a NORMAL state, not an error (see `Card.projectId`'s own comment in `$lib/api`).
 * `DELETE /v1/projects/:id` deletes unconditionally; a card sitting in a board Durable Object has
 * no way to be told its project just vanished. Total: it always returns a string to render, never
 * throws, never leaves a caller needing a spinner that will never resolve.
 */
import type { Project } from '$lib/api';

/** `null` in, `null` out — "no project" is not the same state as "an id the catalogue can't name". */
export function resolveProjectName(projectId: string | null, projects: Pick<Project, 'id' | 'name'>[]): string | null {
  if (!projectId) return null;
  return projects.find((p) => p.id === projectId)?.name ?? projectId;
}

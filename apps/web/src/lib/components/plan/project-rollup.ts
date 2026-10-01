/**
 * Rollup provenance — kept out of `ProjectView.svelte` so it can be tested without rendering
 * (this project's Vitest config cannot import a `.svelte` file; see `add-blocker.ts`'s own note).
 *
 * `ProjectRollup.computedAt`/`partial`/`boardsUnanswered` are required fields on the client type
 * (`$lib/api`) precisely so a caller cannot destructure the numbers out of a rollup without them
 * also being in hand — but a type cannot force a render to use them. This is the one place that
 * turns them into the sentence every rollup number must carry: never a total, a progress bar, or
 * a cost figure with no "as of" line beside it.
 */
import type { ProjectRollup } from '$lib/api';

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // `hour12: false`, not the environment default: the brief's own example ("as of 14:32") is
    // 24-hour, and a rollup's provenance should read the same way regardless of which locale the
    // browser happens to be in.
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return iso;
  }
}

/**
 * `as of 14:32`, or `as of 14:32 · incomplete (1 board did not answer)` when the rollup could not
 * reach every board. A cross-board number presented as live is the one dishonesty this design
 * would otherwise introduce — this is the sentence that heads it off.
 */
export function formatAsOf(rollup: Pick<ProjectRollup, 'computedAt' | 'partial' | 'boardsUnanswered'>): string {
  const time = formatTime(rollup.computedAt);
  if (!rollup.partial) return `as of ${time}`;
  const n = rollup.boardsUnanswered;
  return `as of ${time} · incomplete (${n} board${n === 1 ? '' : 's'} did not answer)`;
}

/** `cardsDone / cardsTotal` as a whole percent, 0 for an empty project, capped at 100. */
export function progressPct(rollup: Pick<ProjectRollup, 'cardsTotal' | 'cardsDone'>): number {
  if (rollup.cardsTotal <= 0) return 0;
  return Math.min(100, Math.round((rollup.cardsDone / rollup.cardsTotal) * 100));
}

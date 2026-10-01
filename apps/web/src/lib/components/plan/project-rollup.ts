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

/** `$1234.56` */
function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

type RollupHeadlineInput = Pick<
  ProjectRollup,
  'cardsTotal' | 'cardsDone' | 'costUsd' | 'cardsOverdue' | 'computedAt' | 'partial' | 'boardsUnanswered'
>;

/**
 * The entire rollup headline — cards done, cost, overdue count, and `formatAsOf`'s provenance —
 * composed into ONE string, so a template has exactly one interpolation to render it through.
 *
 * Before this existed, the obligation that no rollup figure render without `formatAsOf` beside it
 * was held by review alone: the template called `formatAsOf(rollup)` as a SEPARATE interpolation
 * from `{rollup.cardsDone}/{rollup.cardsTotal}` and `fmtUsd(rollup.costUsd)`, so an edit that
 * dropped just the `formatAsOf` call left every figure still rendering and every test green — this
 * project's Vitest config cannot import a `.svelte` file, so nothing could catch it at runtime.
 * Collapsing all four numbers into one return value removes that degree of freedom: there is no
 * longer anywhere in `ProjectView.svelte` a rollup figure that isn't part of the same string as
 * its provenance, and this function is the one place that string is built, so it is the one place
 * a test can hold the property.
 */
export function rollupHeadline(rollup: RollupHeadlineInput): string {
  const overdue = rollup.cardsOverdue > 0 ? ` · ${rollup.cardsOverdue} overdue` : '';
  return `${rollup.cardsDone}/${rollup.cardsTotal} cards done · ${fmtUsd(rollup.costUsd)} · ${formatAsOf(rollup)}${overdue}`;
}

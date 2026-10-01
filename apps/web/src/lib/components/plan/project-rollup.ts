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

type RollupSegmentsInput = Pick<
  ProjectRollup,
  'cardsTotal' | 'cardsDone' | 'costUsd' | 'cardsOverdue' | 'computedAt' | 'partial' | 'boardsUnanswered'
>;

/**
 * One piece of the rollup headline. `figure` is a number derived from the rollup (cards done,
 * cost); `provenance` is `formatAsOf`'s sentence, with the overdue count folded in since overdue
 * is itself a count that is only honest alongside the same "as of" line.
 */
export interface RollupSegment {
  kind: 'figure' | 'provenance';
  text: string;
}

/**
 * The rollup headline as an ordered list of segments — cards done, cost, then provenance last —
 * returned from ONE call so a template renders them through ONE `{#each}` rather than through
 * separate interpolations it could drop independently.
 *
 * This replaces an earlier version (`rollupHeadline`) that concatenated everything into one
 * string: correct for the "nothing to drop independently" property, but a visual downgrade (one
 * flat line instead of a bold figures row over a muted provenance row) that read as a mistake and
 * invited the next edit to "fix" it back into separate interpolations — which would have silently
 * undone the guarantee. Segments solve both at once: `ProjectView.svelte` still renders exactly
 * one value (this array), so dropping provenance now requires *filtering inside the loop* — a
 * visible, deliberate act, not an accidental deletion — while the per-`kind` CSS class in that
 * same loop restores the two-tier look.
 *
 * `cardsDone`/`cardsTotal`/`costUsd` are always `figure`; `formatAsOf(rollup)` (plus the overdue
 * suffix, when there is one) is always the last segment and is always `provenance` — there is
 * exactly one of those per call, for every input, including a `partial` rollup, where it carries
 * the unanswered-board count rather than being omitted.
 */
export function rollupSegments(rollup: RollupSegmentsInput): RollupSegment[] {
  const overdue = rollup.cardsOverdue > 0 ? ` · ${rollup.cardsOverdue} overdue` : '';
  return [
    { kind: 'figure', text: `${rollup.cardsDone}/${rollup.cardsTotal} cards done` },
    { kind: 'figure', text: fmtUsd(rollup.costUsd) },
    { kind: 'provenance', text: `${formatAsOf(rollup)}${overdue}` },
  ];
}

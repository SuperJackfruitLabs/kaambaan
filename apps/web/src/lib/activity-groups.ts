/**
 * A card's activity, grouped by the run that produced it.
 *
 * A published Press card carried **366 activities in one flat list** — 18,806px of scroll against
 * a 900px viewport, about twenty-one screens. 361 of those rows were tool calls; 5 were anything
 * the agent said. Behind them were five separate runs (brief, draft, verify, and two publish
 * attempts) and nothing distinguished one from the next, even though `runId` is on every row and
 * the attempts list already names the stage each run worked.
 *
 * So this groups what was always groupable. It is a pure function of data the drawer already
 * fetches: no new endpoint, nothing more on the wire.
 */
import type { Activity, Attempt } from './api';

export interface ActivityGroup {
  runId: string;
  /** null when the attempts list does not (yet) contain this run — see `groupActivities`. */
  stageKey: string | null;
  agentId: string | null;
  outcome: string | null;
  startedAt: string | null;
  activities: Activity[];
  /** What a COLLAPSED group holds, so its header can say so without being opened. */
  counts: { total: number; action: number; response: number; error: number };
}

/** The rows that carry the story: what the agent said, asked, thought, or failed at. */
export function isNarrative(a: Activity): boolean {
  return a.type !== 'action';
}

/**
 * Rows that are how a run was INTERRUPTED, not what it has to say.
 *
 * An `elicitation` and the `prompt` that answers it are narrative — a reader must see the
 * question and the decision — but they are not the run having said anything, and they must
 * not be what decides whether a run has a story worth showing instead of its tool calls.
 *
 * Reported twice from a live card: a run streaming nothing but tool calls was readable
 * through the no-narrative fallback, and the moment the agent asked permission and the
 * operator answered, every tool call in it disappeared. The run had crossed from "no
 * narrative" to "has narrative" mid-flight on two rows that are not the story.
 */
export function isControlRow(a: Activity): boolean {
  return a.type === 'elicitation' || a.type === 'prompt';
}

export function groupActivities(activities: Activity[], attempts: Attempt[]): ActivityGroup[] {
  const meta = new Map(attempts.map((a) => [a.runId, a]));
  const order: string[] = [];
  const byRun = new Map<string, Activity[]>();

  // Grouped in the order the runs FIRST APPEAR in the stream rather than by the attempts list:
  // the activities are the thing being displayed, and an attempts list that lags or is missing
  // entries must not reorder them.
  for (const a of activities) {
    if (!byRun.has(a.runId)) {
      byRun.set(a.runId, []);
      order.push(a.runId);
    }
    byRun.get(a.runId)!.push(a);
  }

  return order.map((runId) => {
    const rows = byRun.get(runId)!;
    const m = meta.get(runId);
    const counts = { total: rows.length, action: 0, response: 0, error: 0 };
    for (const r of rows) {
      if (r.type === 'action') counts.action += 1;
      else if (r.type === 'error') counts.error += 1;
      else if (r.type === 'response') counts.response += 1;
    }
    return {
      runId,
      // A run with no attempt row still gets a group. Dropping its activities would silently
      // hide work, which is the failure this change exists to fix.
      stageKey: m?.stageKey ?? null,
      agentId: m?.agentId ?? null,
      outcome: m?.outcome ?? null,
      // The first activity's timestamp, not the attempt's: the client's `Attempt` carries no
      // `startedAt`, and inventing one from a field that is not there is how a type stops
      // describing its data.
      startedAt: rows[0]?.ts ?? null,
      activities: rows,
      counts,
    };
  });
}

/**
 * Whether a group should open on arrival.
 *
 * Only the last one, and only when there is more than one: a card mid-flight should show the run
 * that is happening, and a finished card should open showing its shape rather than the tail of a
 * stream nobody asked to be dropped into.
 */
export function defaultOpen(groups: ActivityGroup[], index: number): boolean {
  return groups.length <= 1 || index === groups.length - 1;
}

/**
 * Which rows of a run to render, given the reader's tool-call preference.
 *
 * The preference is "narrative only", and it earns its place: a real run posted 67 activities of
 * which none were narrative — hermes streams tool calls and says nothing in prose. Filtering that
 * to narrative leaves an empty panel under a heading that says "67 events", which reads as
 * *nothing happened* when a great deal did. The panel knew it, too: it printed "Nothing but tool
 * calls in this run" and still showed none of them.
 *
 * So a run with no narrative shows its tool calls. The default is unchanged for every run that
 * has something to say; what changes is that the degenerate case stops hiding its only content.
 */
export function visibleActivities<T>(
  activities: T[],
  isNarrativeRow: (a: T) => boolean,
  showToolCalls: boolean,
  /**
   * Which rows are a control exchange rather than the run's own words. Defaulted to "none"
   * so existing callers keep their exact behaviour; the drawer passes `isControlRow`.
   */
  isControlRowFn: (a: T) => boolean = () => false,
): { rows: T[]; shownBecauseNoNarrative: boolean } {
  if (showToolCalls) return { rows: activities, shownBecauseNoNarrative: false };
  const narrative = activities.filter(isNarrativeRow);
  // A permission exchange does not count toward "this run has a story". If it did, asking a
  // question would silence the only content a reader had — which is the bug this guards.
  const substantive = narrative.filter((a) => !isControlRowFn(a));
  if (substantive.length > 0) return { rows: narrative, shownBecauseNoNarrative: false };
  return { rows: activities, shownBecauseNoNarrative: activities.length > 0 };
}

/**
 * What happened at each stage of a card, in order.
 *
 * The drawer already groups ACTIVITIES by run (`activity-groups.ts`). What it could not show was how
 * each run ENDED: the handoff lived in a single column on the card, overwritten by every
 * `complete()`, and a failure's reason went to a human's notification and the event stream and
 * nowhere a reader could reach. So a card worked at three stages displayed three lists of actions
 * and the last line of its story.
 *
 * Since `runs.handoff_json`, `runs.failure_reason` and `card_references.run_id`
 * (spec 2026-10-02-a-card-remembers-its-stages) every run keeps its own output, and this turns that
 * into the account: per attempt, the stage, the agent, how it ended, what it said, and the evidence
 * it attached.
 *
 * A pure function of what the drawer already fetches — attempts and references. No new endpoint.
 */
import type { Attempt, Reference } from './api';

/** How a run ended. `open` is a real answer: a live run has no outcome, and guessing one is worse. */
export type StageEnding = 'completed' | 'failed' | 'open';

export interface StageEntry {
  runId: string;
  stageKey: string;
  agentId: string;
  ended: StageEnding;
  /** What this run handed on. Null when it failed, or completed with nothing to say. */
  handoff: unknown;
  /** Why it died. Null unless it did. */
  failureReason: string | null;
  model: string | null;
  costUsd: number;
  /** References attached BY THIS RUN. A human's reference has no run and belongs to the card. */
  references: Reference[];
  /**
   * Which attempt at this stage this is, from 1.
   *
   * A retry is its own entry — merging two attempts would hide that the first failed, which is the
   * most useful thing on the card. This is what lets the UI say "attempt 2" instead of showing what
   * looks like two stages.
   */
  attemptOfStage: number;
}

function endingOf(a: Attempt): StageEnding {
  if (a.outcome === 'completed') return 'completed';
  // `crashed` is what `fail()` records; anything else ended but unlabelled is still not a success.
  if (a.outcome) return 'failed';
  return 'open';
}

export function stageAccount(attempts: Attempt[], references: Reference[]): StageEntry[] {
  const seenPerStage = new Map<string, number>();
  const byRun = new Map<string, Reference[]>();
  for (const r of references) {
    // `runId` null means a person attached it, or it predates the column. Either way it belongs to
    // the card and not to somebody's run: inventing an owner is worse than having none.
    if (!r.runId) continue;
    const list = byRun.get(r.runId) ?? [];
    list.push(r);
    byRun.set(r.runId, list);
  }

  return attempts.map((a) => {
    const n = (seenPerStage.get(a.stageKey) ?? 0) + 1;
    seenPerStage.set(a.stageKey, n);
    return {
      runId: a.runId,
      stageKey: a.stageKey,
      agentId: a.agentId,
      ended: endingOf(a),
      handoff: a.handoff ?? null,
      failureReason: a.failureReason ?? null,
      model: a.model,
      costUsd: a.costUsd,
      references: byRun.get(a.runId) ?? [],
      attemptOfStage: n,
    };
  });
}

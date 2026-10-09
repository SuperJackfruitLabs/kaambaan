import { z } from 'zod';

/**
 * What KIND of finish a turn is — said by the agent, as a field, when it calls `complete`.
 *
 * `complete` meant "advance", whatever the handoff said. On 2026-10-09 an `integrate` run handed
 * off `verdict: "unsafe — do not ship"` and the card moved forward to its sign-off gate anyway; a
 * person caught it there, and nothing else would have. The same day an agent that needed a person
 * to approve a device sign-in ended its turn with the link; the board read it as a finished
 * handoff missing a field, refused it twice, and parked the card as a broken handoff.
 *
 * Both were the same missing word. Free text cannot carry it — the verdict above was plain to a
 * person and invisible to the board, and parsing prose for "unsafe" is a guess that fails open —
 * so it is a field, and the board routes on nothing else:
 *
 *  - `pass` — the stage's work is done and good; the card advances. What an absent outcome means
 *    on a stage that judges nothing, which is every stage that existed before this.
 *  - `changes-needed` — the work was judged and is not good enough. The card goes BACK to the
 *    stage's declared `returnStage` with the `findings`, a bounded number of times, and parks for a
 *    person past that. It never advances.
 *  - `needs-person` — the agent cannot go on without a person (a sign-in to approve, a decision
 *    only they can make). The card parks on the `question`, which reaches every surface a question
 *    already reaches (Needs you, the card, the board's chat room); answering it re-queues the SAME
 *    stage with the answer, so the work continues rather than restarting. Not a failure, and not a
 *    refused handoff: it costs no attempt and no automatic rework.
 *
 * Pure, and free of runtime globals, for the reason `completion.ts` gives.
 */
export const StageOutcome = z.enum(['pass', 'changes-needed', 'needs-person']);
export type StageOutcome = z.infer<typeof StageOutcome>;

/** The fields of a `complete` call that an outcome reads. */
export interface OutcomeInput {
  outcome?: StageOutcome;
  /** `changes-needed`: what must change. Posted to the card and handed to the return stage. */
  findings?: string;
  /** `needs-person`: what the person must do or decide. */
  question?: string;
  /** `needs-person`: where they do it — a sign-in page, a PR, a document. */
  url?: string;
}

/** The part of a stage an outcome is routed by. */
export interface OutcomeStage {
  key: string;
  /** Where `changes-needed` sends the card. Declaring it makes the stage a judging stage. */
  returnStage?: string;
}

export type OutcomeRoute =
  /** On to the next stage, exactly as `complete` always did. */
  | { kind: 'advance' }
  /** Back to an earlier stage, with the findings. */
  | { kind: 'return'; to: string }
  /** Stop for a person. `repeated` when the automatic returns are spent. */
  | { kind: 'park'; repeated: boolean; reason: string }
  /** Not a finish the board accepts — goes through the stage's one automatic rework. */
  | { kind: 'refuse'; reason: string }
  /** Waiting on the person the agent asked. */
  | { kind: 'wait' };

function blank(v: string | undefined): boolean {
  return v === undefined || v.trim() === '';
}

/**
 * What is wrong with the call itself, or null.
 *
 * Checked BEFORE the run ends, so a malformed call is an error the agent can correct on the same
 * run rather than a card the board has to reason about.
 */
export function outcomeInputError(input: OutcomeInput): string | null {
  if (input.outcome === 'changes-needed' && blank(input.findings)) {
    return 'outcome "changes-needed" needs `findings`: what must change, for whoever fixes it';
  }
  if (input.outcome === 'needs-person' && blank(input.question)) {
    return 'outcome "needs-person" needs `question`: what the person must do or decide';
  }
  if (input.url !== undefined && !/^https?:\/\/\S+$/.test(input.url.trim())) {
    return '`url` must be an http(s) link';
  }
  return null;
}

/**
 * Where a finished turn sends the card.
 *
 * `returnsSoFar` is how many times this card has already been sent back automatically since a
 * person last acted on it; `limit` is how many the board allows. Counted per card rather than per
 * stage visit because a return IS a new visit — a per-visit count would reset on every lap of the
 * loop it exists to stop.
 */
export function routeOutcome(
  stage: OutcomeStage,
  input: OutcomeInput,
  room: { returnsSoFar: number; limit: number },
): OutcomeRoute {
  const judging = stage.returnStage !== undefined && stage.returnStage !== '';
  switch (input.outcome) {
    case 'needs-person':
      return { kind: 'wait' };
    case 'pass':
      return { kind: 'advance' };
    case 'changes-needed':
      if (!judging) {
        return {
          kind: 'park',
          repeated: false,
          reason: `stage "${stage.key}" found changes needed and declares no return stage`,
        };
      }
      if (room.returnsSoFar >= room.limit) {
        return {
          kind: 'park',
          repeated: true,
          reason: `changes were needed again after ${room.returnsSoFar} automatic return${room.returnsSoFar === 1 ? '' : 's'} to "${stage.returnStage}"`,
        };
      }
      return { kind: 'return', to: stage.returnStage! };
    case undefined:
      // A judging stage that says nothing has not said it passed. Reading silence as a pass is the
      // failure this exists to end, so it is refused — through the stage's one automatic rework,
      // which tells the agent exactly what to add.
      return judging
        ? {
            kind: 'refuse',
            reason: `stage "${stage.key}" judges the work: complete with outcome "pass" or "changes-needed" (with findings)`,
          }
        : { kind: 'advance' };
  }
}

/**
 * What is wrong with a stage's `returnStage`, or null.
 *
 * It must name a stage that exists and comes EARLIER. Itself would re-run the judge on unchanged
 * work; a later stage is a move, not a return — and neither is something a failing verdict means.
 */
export function returnStageError(
  stage: { key: string; order: number; returnStage?: string },
  stages: ReadonlyArray<{ key: string; order: number }>,
): string | null {
  if (stage.returnStage === undefined) return null;
  if (typeof stage.returnStage !== 'string' || stage.returnStage.trim() === '') {
    return `stage "${stage.key}" has an empty return stage — leave it out instead`;
  }
  const target = stages.find((s) => s.key === stage.returnStage);
  if (!target) return `stage "${stage.key}" returns to "${stage.returnStage}", which is not a stage on this board`;
  if (target.order >= stage.order) {
    return `stage "${stage.key}" returns to "${stage.returnStage}", which is not earlier than it — a return goes back`;
  }
  return null;
}

import { z } from 'zod';

/**
 * What a stage may require of a run before the board believes it finished.
 *
 * `complete()` wrote `outcome = 'completed'` and advanced the card **unconditionally**: the handoff
 * was stored verbatim and never inspected, so an agent calling `complete` was the sole author of
 * the claim that its stage was done. On the one card that has run the Press board end to end, that
 * claim was false twice — a board reporting `published` over a commit sitting unpushed on a
 * station, and `completed` for a run that had explicitly refused to publish.
 *
 * Both were patched with stage rules telling agents what to do. Those are advisory, and advisory
 * loses: the URL rewrite that fixed the first failure held because git enforced it.
 *
 * Nothing new is needed in the vocabulary — `RunOutcome` already carries `blocked`. What was
 * missing is that `complete` is unconditional. This makes it earnable.
 *
 * Pure, and free of runtime globals, for the reason the provider registry is: this package
 * compiles with `lib: ["ES2023"]` and `types: []`, and widening that for convenience would cost a
 * real property of it.
 */

export const CompletionRequirement = z
  .object({
    /** Keys the handoff must carry, each present and non-blank. */
    handoff: z.array(z.string()).optional(),
    /** A reference of this shape must exist on the card. */
    reference: z
      .object({
        provider: z.string().optional(),
        sourceType: z.string().optional(),
      })
      .optional(),
    /**
     * The handoff key naming a URL that must answer — slice 3 of the design.
     *
     * Declared here so the shape is stable and so a board configuring it today gets an honest
     * "not checked, and here is why" rather than a silent pass.
     */
    live: z.string().optional(),
  })
  .strict();

export interface CompletionRequirement extends z.infer<typeof CompletionRequirement> {}

export interface CompletionEvidence {
  handoff: unknown;
  references: Array<{ provider: string; sourceType?: string }>;
}

export interface CompletionVerdict {
  met: boolean;
  /** Every failing arm, named. Absent when met. */
  reason?: string;
  /** Arms that could not be evaluated, and why. Recorded, never silent. */
  unchecked?: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Present, and carrying something. A blank is not a report. */
function filled(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function evaluateCompletion(
  requirement: CompletionRequirement | undefined | null,
  evidence: CompletionEvidence,
): CompletionVerdict {
  if (!requirement) return { met: true };

  const failures: string[] = [];
  const unchecked: string[] = [];

  if (requirement.handoff && requirement.handoff.length > 0) {
    const h = evidence.handoff;
    if (!isPlainObject(h)) {
      // A string handoff is a summary, not a report. Naming that distinction beats "invalid".
      failures.push(
        `the handoff must be an object carrying ${requirement.handoff.join(', ')}; got ${h === null || h === undefined ? 'nothing' : typeof h}`,
      );
    } else {
      const missing = requirement.handoff.filter((k) => !filled(h[k]));
      // Every failing key at once: a person fixes both rather than discovering the second on the
      // next run, having already paid for a whole attempt to learn the first.
      if (missing.length > 0) failures.push(`the handoff is missing ${missing.join(', ')}`);
    }
  }

  if (requirement.reference) {
    const want = requirement.reference;
    const hit = evidence.references.some(
      (r) =>
        (want.provider === undefined || r.provider === want.provider) &&
        (want.sourceType === undefined || r.sourceType === want.sourceType),
    );
    if (!hit) {
      const shape = [want.provider, want.sourceType].filter(Boolean).join('/') || 'any';
      failures.push(`this card carries no ${shape} reference`);
    }
  }

  if (requirement.live) {
    // Slice 3. Recorded rather than quietly treated as satisfied: a silent pass is
    // indistinguishable from a real verification, which is the failure this exists to end.
    unchecked.push(`live check of \`${requirement.live}\` — live verification is not built yet`);
  }

  return {
    met: failures.length === 0,
    ...(failures.length > 0 ? { reason: failures.join('; ') } : {}),
    ...(unchecked.length > 0 ? { unchecked } : {}),
  };
}

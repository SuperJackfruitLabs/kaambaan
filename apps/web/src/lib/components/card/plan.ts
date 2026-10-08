/**
 * `spec.plan` — the agent's plan, drawn as a checklist in the card drawer.
 *
 * The spec is free-form, and agents write plans in more than one shape: the documented
 * `{ t, done }`, a list of plain strings, or their own `{ text | step | title | …, completed | … }`.
 * Reading only `step.t` turned a plan of strings into blank checkboxes ("0 / 4 steps"), so every
 * shape is read here, once.
 */

export interface PlanStep {
  text: string;
  done: boolean;
}

/** Where a step's text may live, in order of preference. `t` is the documented key. */
const TEXT_KEYS = ['t', 'text', 'step', 'title', 'label', 'name', 'description'] as const;
/** Boolean flags that mean the step is finished. Only a literal `true` counts. */
const DONE_FLAGS = ['done', 'completed', 'checked'] as const;
const DONE_STATUSES: ReadonlySet<string> = new Set(['done', 'complete', 'completed']);

function stepOf(item: unknown): PlanStep | null {
  if (typeof item === 'string') {
    const text = item.trim();
    return text ? { text, done: false } : null;
  }
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  let text = '';
  for (const k of TEXT_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) {
      text = v.trim();
      break;
    }
  }
  if (!text) return null;
  const status = typeof o.status === 'string' ? o.status.trim().toLowerCase() : '';
  const done = DONE_FLAGS.some((k) => o[k] === true) || DONE_STATUSES.has(status);
  return { text, done };
}

/** The plan's steps, skipping items with no text; null when it is not a list or nothing is usable. */
export function normalisePlan(raw: unknown): PlanStep[] | null {
  if (!Array.isArray(raw)) return null;
  const steps = raw.map(stepOf).filter((s): s is PlanStep => s !== null);
  return steps.length > 0 ? steps : null;
}

/**
 * True when the checklist shows every item of the plan. Only then may the Details section leave
 * `plan` out; otherwise the raw field stays visible there, so nothing the author wrote is hidden.
 */
export function planRendersWhole(raw: unknown): boolean {
  const steps = normalisePlan(raw);
  return steps !== null && Array.isArray(raw) && steps.length === raw.length;
}

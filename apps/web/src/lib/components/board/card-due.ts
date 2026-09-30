/**
 * A card is overdue the day AFTER its due date, and never once it is finished.
 *
 * Extracted from CardTile so it can be tested: it used to be an inline `$derived` comparing a
 * `spec.due` blob value against `Date.now()`, which no test could reach and no test covered.
 *
 * `today` is a parameter rather than read from the clock — the same reason the DO's sweep takes
 * `nowIso`. A test that cannot choose the date can only assert against whatever day it runs on.
 */
export function overdue(dueAt: string | null, state: string, today: string): boolean {
  if (!dueAt) return false;
  if (state === 'completed' || state === 'canceled' || state === 'rejected' || state === 'failed') return false;
  return dueAt < today;
}

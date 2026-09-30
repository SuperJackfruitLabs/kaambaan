/**
 * Formatting for a schedule's `nextFireAt`/`lastFiredAt`, split out so it can be tested — a
 * `.svelte` file cannot be imported by vitest without a component-rendering harness this repo
 * does not carry (see `card-due.ts` for the same split, next door).
 *
 * Shown in the schedule's OWN timezone — the one the operator typed when they made it — rather
 * than the browser's. A card fired "daily at 09:00" in `Asia/Kolkata` should read as 09:00
 * there, not as whatever hour that is for whoever happens to be looking at the settings page.
 */
export function formatFireTime(iso: string | null, timezone: string): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString(undefined, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    // An unreadable zone (saved before a typo was caught, or a runtime that dropped IANA data)
    // must still render something rather than blanking the whole schedule list.
    return iso;
  }
}

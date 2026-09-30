/**
 * Recurrence rules for scheduled cards.
 *
 * A restricted grammar rather than cron, deliberately. Cron is a dependency, a parsing surface and
 * a support burden, and "every 15 minutes / daily at 09:00 / weekly on mon / monthly on 1" is the
 * whole of what maintenance cadence needs. The stored field is free text, so a cron expression can
 * be accepted later without touching the schema.
 *
 * Pure: no clock, no I/O, no Durable Object. `nextFireAt` takes the instant to search from, which
 * is what makes every case below testable.
 */

export type Rule =
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days' }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; dow: number; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number };

/** The Worker cron ticks every 5 minutes, so a shorter interval is a promise we cannot keep. */
const MIN_INTERVAL_MINUTES = 5;

const DOW: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const FORMS =
  'accepted forms: "every <n> minutes|hours|days", "daily at HH:MM", ' +
  '"weekly on <mon-sun> at HH:MM", "monthly on <1-28> at HH:MM"';

function clock(h: string, m: string): { hour: number; minute: number } | null {
  const hour = Number(h);
  const minute = Number(m);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function parseRule(text: string): { ok: true; rule: Rule } | { ok: false; error: string } {
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ');

  const interval = s.match(/^every (\d+) (minutes?|hours?|days?)$/);
  if (interval) {
    const every = Number(interval[1]);
    const unit = (interval[2]!.endsWith('s') ? interval[2]! : `${interval[2]!}s`) as
      | 'minutes' | 'hours' | 'days';
    if (every <= 0) return { ok: false, error: 'an interval must be at least 1' };
    const asMinutes = unit === 'minutes' ? every : unit === 'hours' ? every * 60 : every * 1440;
    if (asMinutes < MIN_INTERVAL_MINUTES) {
      return {
        ok: false,
        error: `the shortest interval is ${MIN_INTERVAL_MINUTES} minutes — the sweep runs every ${MIN_INTERVAL_MINUTES} minutes, so anything shorter would not be honoured`,
      };
    }
    return { ok: true, rule: { kind: 'interval', every, unit } };
  }

  const daily = s.match(/^daily at (\d{1,2}):(\d{2})$/);
  if (daily) {
    const t = clock(daily[1]!, daily[2]!);
    if (!t) return { ok: false, error: 'that is not a time of day' };
    return { ok: true, rule: { kind: 'daily', ...t } };
  }

  const weekly = s.match(/^weekly on ([a-z]{3}) at (\d{1,2}):(\d{2})$/);
  if (weekly) {
    const dow = DOW[weekly[1]!];
    if (dow === undefined) return { ok: false, error: `"${weekly[1]}" is not a day — use mon, tue, wed, thu, fri, sat or sun` };
    const t = clock(weekly[2]!, weekly[3]!);
    if (!t) return { ok: false, error: 'that is not a time of day' };
    return { ok: true, rule: { kind: 'weekly', dow, ...t } };
  }

  const monthly = s.match(/^monthly on (\d{1,2}) at (\d{1,2}):(\d{2})$/);
  if (monthly) {
    const day = Number(monthly[1]);
    // 29-31 are refused rather than clamped. Clamping makes "monthly on 31" mean the 28th in
    // February and the 31st elsewhere, which is two different rules wearing one name; skipping
    // makes it silently not fire. Refusing says so at the only moment anyone is listening.
    if (day < 1 || day > 28) {
      return { ok: false, error: 'a monthly day must be between 1 and 28, so it exists in every month' };
    }
    const t = clock(monthly[2]!, monthly[3]!);
    if (!t) return { ok: false, error: 'that is not a time of day' };
    return { ok: true, rule: { kind: 'monthly', day, ...t } };
  }

  return { ok: false, error: `could not read "${text.trim()}" — ${FORMS}` };
}

/** The wall-clock fields of an instant, as seen in a named zone. */
function zonedParts(at: Date, timezone: string): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '0';
  const weekday = (parts.find((p) => p.type === 'weekday')?.value ?? 'Sun').slice(0, 3).toLowerCase();
  return {
    y: Number(get('year')), mo: Number(get('month')), d: Number(get('day')),
    // Intl renders midnight as "24" in some locales; normalise it.
    h: Number(get('hour')) % 24, mi: Number(get('minute')),
    dow: DOW[weekday] ?? 0,
  };
}

/** How far the named zone is from UTC at this instant, in minutes. */
function offsetMinutes(at: Date, timezone: string): number {
  const p = zonedParts(at, timezone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  // Seconds and milliseconds are not in `p`, so compare on the minute.
  return (asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000;
}

/**
 * The instant at which a given wall clock occurs in a zone.
 *
 * Two passes: guess by treating the wall clock as UTC, measure the zone's offset at that guess,
 * then correct. The second pass matters across a DST boundary, where the offset at the guess is not
 * the offset at the answer. A wall clock that does not exist (the spring-forward hour) lands on the
 * next instant that does, which is the conventional behaviour and is not worth more code here.
 */
function fromZonedWallClock(
  y: number, mo: number, d: number, h: number, mi: number, timezone: string,
): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const corrected = new Date(guess.getTime() - offsetMinutes(guess, timezone) * 60000);
  return new Date(corrected.getTime() - (offsetMinutes(corrected, timezone) - offsetMinutes(guess, timezone)) * 60000);
}

export function nextFireAt(rule: Rule, timezone: string, afterIso: string): string {
  const after = new Date(afterIso);

  if (rule.kind === 'interval') {
    const ms = rule.unit === 'minutes' ? 60000 : rule.unit === 'hours' ? 3600000 : 86400000;
    return new Date(after.getTime() + rule.every * ms).toISOString();
  }

  const p = zonedParts(after, timezone);

  // Walk candidate days forward until one lands strictly after `after`. At most 40 iterations,
  // which covers the longest monthly gap plus a DST shift; a loop that cannot terminate is worse
  // than one with a stated bound.
  for (let i = 0; i < 40; i += 1) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();

    if (rule.kind === 'weekly' && day.getUTCDay() !== rule.dow) continue;
    if (rule.kind === 'monthly' && d !== rule.day) continue;

    const candidate = fromZonedWallClock(y, mo, d, rule.hour, rule.minute, timezone);
    if (candidate.getTime() > after.getTime()) return candidate.toISOString();
  }

  throw new Error(`no next occurrence found for ${JSON.stringify(rule)} in ${timezone} after ${afterIso}`);
}

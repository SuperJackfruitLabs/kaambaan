import { describe, it, expect } from 'vitest';
import { parseRule, nextFireAt, type Rule } from '../src/board/recurrence';

function mustParse(text: string): Rule {
  const r = parseRule(text);
  if (!r.ok) throw new Error(`expected "${text}" to parse: ${r.error}`);
  return r.rule;
}

describe('parseRule', () => {
  it('reads the four forms', () => {
    expect(mustParse('every 30 minutes')).toEqual({ kind: 'interval', every: 30, unit: 'minutes' });
    expect(mustParse('daily at 09:00')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    expect(mustParse('weekly on mon at 08:30')).toEqual({ kind: 'weekly', dow: 1, hour: 8, minute: 30 });
    expect(mustParse('monthly on 1 at 00:00')).toEqual({ kind: 'monthly', day: 1, hour: 0, minute: 0 });
  });

  it('is case- and space-insensitive', () => {
    expect(mustParse('  DAILY  AT  09:00 ')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
  });

  it('refuses an interval below the cron tick, because it cannot be honoured', () => {
    const r = parseRule('every 2 minutes');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('5');
  });

  it('refuses a monthly day above 28, rather than silently skipping February', () => {
    const r = parseRule('monthly on 31 at 09:00');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('28');
  });

  it('refuses nonsense with a message naming the accepted forms', () => {
    const r = parseRule('when I feel like it');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('every');
  });

  it('refuses an impossible clock time', () => {
    expect(parseRule('daily at 25:00').ok).toBe(false);
    expect(parseRule('daily at 09:60').ok).toBe(false);
  });

  it('refuses a zero interval, by the "at least 1" message rather than the five-minute floor', () => {
    const r = parseRule('every 0 days');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('at least 1');
  });
});

describe('nextFireAt', () => {
  it('advances an interval from the given instant', () => {
    expect(nextFireAt(mustParse('every 30 minutes'), 'UTC', '2026-09-30T10:00:00.000Z')).toBe(
      '2026-09-30T10:30:00.000Z',
    );
  });

  it('finds today’s daily time when it is still ahead', () => {
    expect(nextFireAt(mustParse('daily at 09:00'), 'UTC', '2026-09-30T08:00:00.000Z')).toBe(
      '2026-09-30T09:00:00.000Z',
    );
  });

  it('rolls to tomorrow when the daily time has passed', () => {
    expect(nextFireAt(mustParse('daily at 09:00'), 'UTC', '2026-09-30T09:00:00.000Z')).toBe(
      '2026-10-01T09:00:00.000Z',
    );
  });

  it('resolves a wall-clock time in a named zone, not in UTC', () => {
    // 09:00 in Asia/Kolkata (UTC+5:30) is 03:30Z.
    expect(nextFireAt(mustParse('daily at 09:00'), 'Asia/Kolkata', '2026-09-30T00:00:00.000Z')).toBe(
      '2026-09-30T03:30:00.000Z',
    );
  });

  it('finds the next named weekday', () => {
    // 2026-09-30 is a Wednesday; the next Monday is 2026-10-05.
    expect(nextFireAt(mustParse('weekly on mon at 08:30'), 'UTC', '2026-09-30T12:00:00.000Z')).toBe(
      '2026-10-05T08:30:00.000Z',
    );
  });

  it('rolls a monthly rule into the next month', () => {
    expect(nextFireAt(mustParse('monthly on 1 at 00:00'), 'UTC', '2026-09-30T12:00:00.000Z')).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('is strictly forward: firing never returns the instant it was given', () => {
    const exact = '2026-09-30T09:00:00.000Z';
    expect(nextFireAt(mustParse('daily at 09:00'), 'UTC', exact)).not.toBe(exact);
  });

  it('gets the DST spring-forward right, which is exactly what the second pass in fromZonedWallClock is for', () => {
    // America/New_York's 2026 spring-forward transition lands at 2026-03-08T07:00:00Z. A single-pass
    // version of fromZonedWallClock measures the zone's offset only at the naive guess — for this wall
    // clock that guess falls just before the transition, so it is measured in EST (UTC-5) and answers
    // 08:00Z, an hour late. Read without its comment, the second pass looks like it recomputes the same
    // offset for no reason, which makes deleting it look like a harmless cleanup; this test is what
    // stops that. Without it, 13/13 stay green after the second pass is removed.
    expect(nextFireAt(mustParse('daily at 03:00'), 'America/New_York', '2026-03-08T00:00:00.000Z')).toBe(
      '2026-03-08T07:00:00.000Z',
    );
  });
});

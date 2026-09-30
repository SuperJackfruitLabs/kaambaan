import { describe, it, expect } from 'vitest';

describe('workerd Intl', () => {
  it('formats a wall-clock time in a named IANA zone', () => {
    const f = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    // 2026-01-15T00:00:00Z is 05:30 in Asia/Kolkata (UTC+5:30).
    expect(f.format(new Date('2026-01-15T00:00:00Z'))).toBe('05:30');
  });

  it('recognises the zone rather than silently falling back to UTC', () => {
    const resolved = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata' }).resolvedOptions();
    // ICU canonicalises Asia/Kolkata to its older alias Asia/Calcutta, so the string that comes
    // back is NOT the string that went in. Asserting equality here fails on a runtime that
    // supports zones perfectly well. What matters is that a REAL zone came back: a runtime with no
    // zone data answers 'UTC'.
    expect(resolved.timeZone).not.toBe('UTC');
    // …and that the spelling it returned denotes the same zone as the one we asked for.
    const at = new Date('2026-01-15T00:00:00Z');
    const hhmm = (tz: string): string =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(at);
    expect(hhmm(resolved.timeZone)).toBe(hhmm('Asia/Kolkata'));
  });

  it('throws RangeError on an unknown zone — which is how a schedule validates one', () => {
    // Task 9 uses this: a zone is validated by trying to construct a formatter, never by
    // comparing strings, because the canonical spelling differs from the input.
    expect(() => new Intl.DateTimeFormat('en-GB', { timeZone: 'Mars/Olympus' })).toThrow(RangeError);
  });
});

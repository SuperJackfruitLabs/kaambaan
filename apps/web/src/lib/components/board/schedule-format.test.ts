import { describe, it, expect } from 'vitest';
import { formatFireTime } from './schedule-format';

describe('formatFireTime', () => {
  it('formats an instant in the given zone', () => {
    // 09:00 UTC is 14:30 in Kolkata (UTC+5:30) — a zone-aware read, not a raw ISO dump.
    const out = formatFireTime('2026-10-01T09:00:00.000Z', 'Asia/Kolkata');
    expect(out).toContain('2:30');
  });

  it('falls back to the raw ISO string for a timezone the runtime cannot read', () => {
    // Never throws — a schedule saved before a zone typo was caught, or a runtime drift, must
    // still render something rather than blanking the whole list.
    expect(formatFireTime('2026-10-01T09:00:00.000Z', 'Nowhere/Fake')).toBe('2026-10-01T09:00:00.000Z');
  });

  it('answers "never" for a null instant', () => {
    expect(formatFireTime(null, 'UTC')).toBe('never');
  });
});

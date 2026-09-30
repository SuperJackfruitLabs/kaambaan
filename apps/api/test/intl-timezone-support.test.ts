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

  it('reports the zone back, rather than silently falling back to UTC', () => {
    const resolved = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata' }).resolvedOptions();
    expect(resolved.timeZone).toBe('Asia/Kolkata');
  });
});

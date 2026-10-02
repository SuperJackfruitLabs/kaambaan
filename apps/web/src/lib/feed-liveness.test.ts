import { describe, expect, it } from 'vitest';
import { feedIsStalled, STALL_AFTER_MS } from './feed-liveness';

/**
 * A feed that has stopped delivering is not a live one, whatever the socket says.
 *
 * Measured on a real card: over 45 seconds the API went from 311 activities to 318 while the open
 * panel sat at 298 and never caught up. `connected` was still true, nothing said "offline", and no
 * reconnect ran — because `connected` is set false on `close`, and this socket never closed. It just
 * stopped carrying anything.
 *
 * A reload fixed it, which is the signature: the data was always there, and a long-lived session had
 * quietly stopped being live. The store's own comment names this as the thing to avoid — "a live
 * board that silently stops being live is worse than one that never claimed to be" — and that was
 * fixed for `close`, through a door this failure does not use.
 */
describe('feedIsStalled', () => {
  const now = 1_000_000;

  it('is false while messages are arriving', () => {
    expect(feedIsStalled({ now, lastMessageAt: now - 1_000, hasWorkInFlight: true })).toBe(false);
  });

  it('is TRUE when a working card has gone quiet past the threshold', () => {
    // The case that was invisible. A card in `working` posts an activity per tool call, so a gap this
    // long while something is running means the carrier is dead, not that the agent is thinking.
    expect(feedIsStalled({ now, lastMessageAt: now - STALL_AFTER_MS - 1, hasWorkInFlight: true })).toBe(true);
  });

  it('is false on an IDLE board however long the silence', () => {
    // The thing that makes this safe to act on. A board with nothing running is legitimately silent
    // for hours, and treating that as a fault would reconnect every viewer of every quiet board on a
    // timer — a self-inflicted thundering herd, which is what the backoff jitter exists to avoid.
    expect(feedIsStalled({ now, lastMessageAt: now - STALL_AFTER_MS * 100, hasWorkInFlight: false })).toBe(false);
  });

  it('is false before any message has arrived, so a fresh socket is given its chance', () => {
    // `lastMessageAt` is null between `open` and the first event. Calling that stalled would tear
    // down a socket that has not had time to say anything.
    expect(feedIsStalled({ now, lastMessageAt: null, hasWorkInFlight: true })).toBe(false);
  });

  it('does not fire exactly AT the threshold, only past it', () => {
    // A boundary that fires on equality makes the check depend on clock granularity, and a reconnect
    // triggered by a rounding error is a reconnect nobody can explain.
    expect(feedIsStalled({ now, lastMessageAt: now - STALL_AFTER_MS, hasWorkInFlight: true })).toBe(false);
  });

  it('tolerates a clock that jumped backwards', () => {
    // `Date.now()` is not monotonic: a laptop waking or an NTP correction can put `lastMessageAt` in
    // the future. A negative age must read as "just heard from it", never as a huge stall.
    expect(feedIsStalled({ now, lastMessageAt: now + 60_000, hasWorkInFlight: true })).toBe(false);
  });

  it('uses a threshold longer than the card drawer coalesces for', () => {
    // If this fired faster than a burst of activity is debounced, a busy card would look stalled at
    // its busiest. Stated as an assertion so the two numbers cannot drift apart silently.
    expect(STALL_AFTER_MS).toBeGreaterThan(5_000);
  });
});

/**
 * Is the live feed still carrying anything?
 *
 * `connected` was set true on the socket's `open` and false on its `close`, and a socket that stops
 * DELIVERING without closing fires neither. Measured on a real card: the API went from 311 activities
 * to 318 over 45 seconds while the open panel sat at 298 and never caught up — `connected` still true,
 * no "offline", no reconnect. A reload fixed it, which is the signature of a session that quietly
 * stopped being live rather than a feature that never worked.
 *
 * An idle proxy dropping a connection, a Worker rotating underneath, a laptop waking from sleep: none
 * of them necessarily produce a `close` event the page sees. So liveness has to be observed, not
 * trusted.
 *
 * The store's own comment already names the standard this failed: "a live board that silently stops
 * being live is worse than one that never claimed to be."
 */

/**
 * How long a WORKING board may be silent before the feed is presumed dead.
 *
 * An agent working a card posts an activity per tool call — a real run posted 67 — and the longest
 * natural gap observed between them on a live card was tens of seconds, inside a single model turn.
 * 90s is comfortably past that and still inside a person's patience for noticing a stale panel.
 *
 * Deliberately NOT shorter: a reconnect costs a full board refetch, and a threshold that fires during
 * a slow turn would churn the connection exactly when the card is busiest.
 */
export const STALL_AFTER_MS = 90_000;

export interface FeedState {
  /** Now, in epoch milliseconds. */
  now: number;
  /** When the last socket message arrived, or null when none has since the socket opened. */
  lastMessageAt: number | null;
  /**
   * Is anything running that SHOULD be producing events?
   *
   * The guard that makes this safe to act on. A board with nothing in flight is legitimately silent
   * for hours, and treating that as a fault would have every viewer of every quiet board reconnecting
   * on a timer — the thundering herd the backoff jitter exists to prevent.
   */
  hasWorkInFlight: boolean;
}

export function feedIsStalled({ now, lastMessageAt, hasWorkInFlight }: FeedState): boolean {
  if (!hasWorkInFlight) return false;
  // Between `open` and the first event there is nothing to measure, and tearing down a socket that
  // has not had time to speak would make a slow first event look like a dead connection.
  if (lastMessageAt === null) return false;
  const age = now - lastMessageAt;
  // `Date.now()` is not monotonic — a wake or an NTP correction can put the last message in the
  // future. Belt and braces: the comparison below already answers false for a negative age, so this
  // states the intent rather than carrying it, and removing it changes no behaviour.
  if (age < 0) return false;
  return age > STALL_AFTER_MS;
}

/**
 * How often the watchdog looks.
 *
 * A third of the stall threshold, so a dead feed is noticed within about two checks of the deadline
 * rather than up to a whole threshold late — and infrequently enough that an idle board costs nothing.
 */
export const STALL_CHECK_MS = 30_000;

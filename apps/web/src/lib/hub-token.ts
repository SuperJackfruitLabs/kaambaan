/**
 * Carrying authority from the browser.
 *
 * The control pair asks who may dispatch which agent, and the answer has to
 * arrive **with the act** — recorded against the card when it is queued, because
 * the agent claims it long afterwards with nobody around to ask
 * (`charter` → `decisions/2026-08-13-ecosystem-identity.md`, Decision 4).
 *
 * A kaambaan session cannot answer that: kaambaan is not the issuer. So the app
 * fetches a short-lived token from the hub, using the hub session the operator
 * already has in this browser, and sends it alongside its own cookie. kaambaan
 * verifies it offline and records the `mayDispatch` it carries.
 *
 * Chosen over kaambaan keeping its own grant store (kaambaan#43, option B),
 * because two grant stores is the drift
 * `decisions/2026-08-15-a-grant-names-an-agent-per-plane.md` warns about: an
 * asymmetric grant is worse than no grant, since permission starts depending on
 * which door the work arrived through.
 *
 * **Nothing here is a credential.** The token is minted by the hub from a
 * cookie this code cannot read, and it is useless to anyone who cannot already
 * authenticate as that principal.
 */

const HUB_URL = import.meta.env.PUBLIC_HUB_URL ?? 'https://hub.agentpod.dev';

/** Tokens live five minutes; refresh with room to spare. */
const REFRESH_MARGIN_MS = 60_000;

let cached: { token: string; expiresAtMs: number } | null = null;
let inFlight: Promise<string | null> | null = null;

/** `exp` from the payload, without verifying — the hub verifies; this only schedules. */
function expiryOf(jwt: string): number {
  try {
    const [, payload] = jwt.split('.');
    if (!payload) return 0;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * A hub token for this operator, or null.
 *
 * Null is an ordinary answer and must stay one: an operator with no hub session,
 * a hub that is down, a deployment with no issuer configured. The app keeps
 * working — it simply queues cards without authority, and under enforcement
 * those cards are refused with a reason that says exactly that, rather than the
 * UI breaking.
 */
export async function hubToken(): Promise<string | null> {
  const now = Date.now();
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > now) return cached.token;

  // One fetch at a time. A board view can fire several requests at once and
  // each would otherwise mint its own token.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(`${HUB_URL}/api/auth/token`, {
        // The hub session cookie, which is what authorises the mint. The hub
        // allows this origin explicitly; a site not on that list gets nothing.
        credentials: 'include',
      });
      if (!res.ok) return null;

      const body = (await res.json()) as { token?: string };
      if (!body.token) return null;

      const expiresAtMs = expiryOf(body.token);
      // A token whose expiry cannot be read is not cached — better to re-fetch
      // than to hold something we cannot schedule around.
      cached = expiresAtMs > 0 ? { token: body.token, expiresAtMs } : null;
      return body.token;
    } catch {
      // Offline, blocked, CORS — all the same answer: no authority this time.
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Drop the cached token — after signing out, or when the hub rejects it. */
export function forgetHubToken(): void {
  cached = null;
}

/**
 * Headers for a kaambaan request, carrying authority when there is any.
 *
 * The `Authorization` header is additive: kaambaan still reads its own session
 * cookie, and `resolveHubUser` only runs when the cookie path declines. This is
 * what lets a board with no hub issuer keep working unchanged.
 */
export async function withAuthority(headers: Record<string, string>): Promise<Record<string, string>> {
  const token = await hubToken();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

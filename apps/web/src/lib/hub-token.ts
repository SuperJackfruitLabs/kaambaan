/**
 * Carrying authority from the browser.
 *
 * The control pair asks who may dispatch which agent, and the answer has to
 * arrive **with the act** — recorded against the card when it is queued, because
 * the agent claims it long afterwards with nobody around to ask
 * (`charter` → `decisions/2026-08-13-ecosystem-identity.md`, Decision 4).
 *
 * A kaambaan session cannot answer that: kaambaan is not the issuer. So the app
 * carries a short-lived token minted by the hub, sends it alongside its own
 * cookie, and kaambaan verifies it offline and records the `mayDispatch` it
 * carries.
 *
 * **How that token is obtained changed, because the original way never worked.**
 * It used to be one cross-site `fetch` to the hub with `credentials: 'include'`.
 * The hub's session cookie is `SameSite=Lax` on `.agentpod.dev`, and this page is
 * on `kaambaan.dev` — a different registrable domain — so the browser never
 * attached it, the hub answered 401, and `hubToken()` said null. Silently, and in
 * production only, since the two share an origin nowhere else. Every card queued
 * from the deployed UI carried no authority.
 *
 * Lax does permit **top-level navigation**, so the operator now *goes* to the hub
 * (`beginHubAuthorization()`) instead of the page *calling* it, and the hub sends
 * a one-time code back to kaambaan's own Worker, which spends it server-to-server
 * and holds the result. `hubToken()` then reads it same-origin. See
 * `apps/api/src/auth/hub-oauth.ts`.
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
 * Cache a token we have just been handed, and answer with it.
 *
 * A token whose expiry cannot be read is not cached — better to re-fetch than to
 * hold something we cannot schedule around.
 */
function remember(token: string | null | undefined): string | null {
  if (!token) return null;
  const expiresAtMs = expiryOf(token);
  cached = expiresAtMs > 0 ? { token, expiresAtMs } : null;
  return token;
}

/**
 * The token our own back end holds for this browser, if the operator has
 * connected (`apps/api/src/auth/hub-oauth.ts`).
 *
 * Same-origin, so kaambaan's own cookie travels and the hub's never has to. This
 * is the path that actually works from `kaambaan.dev`, which is why it is asked
 * first.
 */
async function tokenFromOurBackEnd(): Promise<string | null> {
  try {
    const res = await fetch('/hub/token', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string | null };
    return remember(body.token);
  } catch {
    return null;
  }
}

/**
 * The hub, asked directly, with the operator's hub session cookie.
 *
 * Kept as a fallback rather than deleted: it is the correct path for a
 * deployment that shares the hub's registrable domain, and it is what the
 * back-end handoff exists to work around rather than replace. From
 * `kaambaan.dev` it answers 401 — the browser will not attach a `SameSite=Lax`
 * cookie to a cross-site fetch — and 401 is null, which is an ordinary answer.
 */
async function tokenFromHubDirectly(): Promise<string | null> {
  try {
    const res = await fetch(`${HUB_URL}/api/auth/token`, {
      // The hub session cookie, which is what authorises the mint. The hub
      // allows this origin explicitly; a site not on that list gets nothing.
      credentials: 'include',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return remember(body.token);
  } catch {
    // Offline, blocked, CORS — all the same answer: no authority this time.
    return null;
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
 *
 * **This function never navigates.** Wanting authority is not the same as asking
 * for it: a board that redirected to a sign-in page because a background refresh
 * came back empty would take a standalone kaambaan — a first-class deployment —
 * and send its operator to a hub that does not exist. Starting the flow is
 * `beginHubAuthorization()`, and only an operator calls that.
 */
export async function hubToken(): Promise<string | null> {
  const now = Date.now();
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > now) return cached.token;

  // One fetch at a time. A board view can fire several requests at once and
  // each would otherwise mint its own token.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      return (await tokenFromOurBackEnd()) ?? (await tokenFromHubDirectly());
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Send the operator to the hub to authorise this plane — the one thing here that
 * navigates, and only ever because someone asked.
 *
 * Our own back end mints the PKCE verifier and holds it in a cookie this code
 * cannot read, so all that comes back is a URL. Two consequences, both wanted:
 * the verifier never exists in this browser's script, so a code read out of an
 * address bar or a history entry is worth nothing without the Worker; and a
 * deployment with no hub configured answers 503, so **nothing navigates
 * anywhere**. A standalone kaambaan stays exactly where it is.
 *
 * Returns whether the navigation was started. `false` is not an error — it is a
 * board with no hub to connect to, or a hub that could not be reached.
 *
 * `navigate` is injectable only so the "never navigates" case can be asserted;
 * every real caller passes nothing.
 */
export async function beginHubAuthorization(
  navigate: (url: string) => void = (url) => globalThis.location.assign(url),
): Promise<boolean> {
  try {
    const res = await fetch('/hub/connect', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) return false;
    const body = (await res.json()) as { url?: string };
    if (!body.url) return false;
    navigate(body.url);
    return true;
  } catch {
    return false;
  }
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

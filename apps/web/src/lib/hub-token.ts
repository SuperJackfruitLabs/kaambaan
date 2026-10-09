/**
 * Carrying authority from the browser.
 *
 * The control pair asks who may dispatch which agent, and the answer has to
 * arrive **with the act** — recorded against the card when it is queued, because
 * the agent claims it long afterwards with nobody around to ask
 * (`charter` → `decisions/2026-08-13-ecosystem-identity.md`, Decision 4).
 *
 * A superpipeline session cannot answer that: superpipeline is not the issuer. So the app
 * carries a short-lived token minted by the hub, sends it alongside its own
 * cookie, and superpipeline verifies it offline and records the `mayDispatch` it
 * carries.
 *
 * **How that token is obtained changed, because the original way never worked.**
 * It used to be one cross-site `fetch` to the hub with `credentials: 'include'`.
 * The hub's session cookie is `SameSite=Lax` on `.agentpod.dev`, and this page is
 * on `app.superpipeline.dev` — a different registrable domain — so the browser never
 * attached it, the hub answered 401, and `hubToken()` said null. Silently, and in
 * production only, since the two share an origin nowhere else. Every card queued
 * from the deployed UI carried no authority.
 *
 * Lax does permit **top-level navigation**, so the operator now *goes* to the hub
 * (`beginHubAuthorization()`) instead of the page *calling* it, and the hub sends
 * a one-time code back to superpipeline's own Worker, which spends it server-to-server
 * and holds the result. `hubToken()` then reads it same-origin. See
 * `apps/api/src/auth/hub-oauth.ts`.
 *
 * Chosen over superpipeline keeping its own grant store (superpipeline#43, option B),
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
/**
 * The hub-audience token, in plane mode only (issuer contract §3.1, amended). The app token's `aud`
 * is this deployment, which the hub refuses, so the assignee picker gets a second token that our
 * Worker requested for the hub's resource. Minted alongside the app token and refreshed with it.
 */
let cachedHubAud: { token: string; expiresAtMs: number } | null = null;
/** The Superlibrary-audience token (spec §9 Embedding), for the card drawer. Minted by our Worker on request. */
let cachedLibrary: { token: string; expiresAtMs: number } | null = null;
/** False once the Worker has said this deployment has no Superlibrary: nothing to preview or relate. */
let libraryAbsent = false;
let libraryInFlight: Promise<string | null> | null = null;
let lastSignIn: 'github' | 'org-plane' | null = null;
let inFlight: Promise<string | null> | null = null;

/** `exp` from the payload, without verifying — the hub verifies; this only schedules. */
export function expiryOf(jwt: string): number {
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
 * Every `/hub/token` request goes through here, one at a time. The Worker spends the person's
 * rotating refresh token on each, so two overlapping requests from one tab would present the same
 * token twice: a replay to the plane. The queue survives a failed request.
 */
/**
 * A hung request must not hold the queue: it is abandoned (and answers null) after this long.
 * The trade-off: abandoning a request the Worker has already started can lose the newest refresh
 * token (the browser never sees its Set-Cookie), which costs a silent re-authorize. So the bound
 * is generous, well past a slow plane, and only there to end a request that will never answer.
 */
const HUB_TOKEN_TIMEOUT_MS = 30_000;
let hubTokenTail: Promise<unknown> | null = null;
function hubTokenFetch(url: string): Promise<Response> {
  const start = async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HUB_TOKEN_TIMEOUT_MS);
    try {
      return await fetch(url, { credentials: 'same-origin', signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const run = hubTokenTail ? hubTokenTail.then(start) : start();
  const mine = run.then(() => undefined, () => undefined);
  hubTokenTail = mine;
  void mine.then(() => { if (hubTokenTail === mine) hubTokenTail = null; });
  return run;
}

/** What our own back end knows about the hub, and about this browser's authority. */
export interface HubStatus {
  /**
   * Whether this deployment has a hub at all.
   *
   * The one thing a null token cannot say. An operator who has not connected
   * and an operator with nowhere to connect *to* both hold no token, and only
   * the first should ever be offered a button — a standalone superpipeline is a
   * first-class deployment (migration 0003), not a half-configured one, and a
   * button that leads nowhere is worse than no button.
   */
  configured: boolean;
  /** A hub token for this operator, or null. Null is an ordinary answer. */
  token: string | null;
  /** How this deployment signs people in. Absent (an older Worker) reads as GitHub. */
  signIn: 'github' | 'org-plane';
}

/** The sign-in mode the last `hubStatus()` saw, or null before the first call. */
export function signInMode(): 'github' | 'org-plane' | null {
  return lastSignIn;
}

/**
 * Ask our own back end for both at once (`apps/api/src/auth/hub-oauth.ts`).
 *
 * Same-origin, so superpipeline's own cookie travels and the hub's never has to.
 * This is the path that actually works from `superpipeline.dev`, which is why
 * `hubToken()` asks it first.
 *
 * A missing `hubConfigured` reads as **not** configured. That is the safe
 * direction on both sides: an older Worker that does not send the field simply
 * shows no connect button, where the other reading would offer to start a flow
 * that answers 503.
 */
export async function hubStatus(): Promise<HubStatus> {
  try {
    const res = await hubTokenFetch('/hub/token');
    // A non-2xx can still say which mode this is: plane mode answers a transient refresh failure
    // with a retryable 503 that names `signIn`, and reading it as hub mode would send this page
    // to the hub for a token the hub must not be asked for.
    const body = ((await res.json().catch(() => null)) ?? {}) as { token?: string | null; hubToken?: string | null; hubConfigured?: boolean; signIn?: string };
    if (!res.ok) {
      if (body.signIn !== 'org-plane') return { configured: false, token: null, signIn: 'github' };
      lastSignIn = 'org-plane';
      return { configured: body.hubConfigured === true, token: null, signIn: 'org-plane' };
    }
    const signIn = body.signIn === 'org-plane' ? 'org-plane' : 'github';
    lastSignIn = signIn;
    if (signIn === 'org-plane') {
      const exp = body.hubToken ? expiryOf(body.hubToken) : 0;
      cachedHubAud = body.hubToken && exp > 0 ? { token: body.hubToken, expiresAtMs: exp } : null;
    }
    return { configured: body.hubConfigured === true, token: remember(body.token), signIn };
  } catch {
    // Offline, or a back end that is not there. Neither is an error to show.
    return { configured: false, token: null, signIn: 'github' };
  }
}

/**
 * The hub, asked directly, with the operator's hub session cookie.
 *
 * Kept as a fallback rather than deleted: it is the correct path for a
 * deployment that shares the hub's registrable domain, and it is what the
 * back-end handoff exists to work around rather than replace. From
 * `superpipeline.dev` it answers 401 — the browser will not attach a `SameSite=Lax`
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
 * came back empty would take a standalone superpipeline — a first-class deployment —
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
      const status = await hubStatus();
      // In plane mode the token is the app's (aud = this deployment); the hub would refuse it, and
      // there is no hub cookie to fall back on. Null is the ordinary answer.
      if (status.signIn === 'org-plane') return status.token;
      return status.token ?? (await tokenFromHubDirectly());
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
 * anywhere**. A standalone superpipeline stays exactly where it is.
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

/**
 * A token the HUB will accept, for calls made to the hub itself (the assignee picker), or null.
 *
 * Before cutover that is the same token `hubToken()` returns — the hub minted it. In plane mode it
 * is the separate hub-audience token, never the app token: sending the app's token to the hub
 * would be refused at best and, at worst, hand one product's credential to another.
 */
export async function hubAudienceToken(): Promise<string | null> {
  const token = await hubToken();
  if (lastSignIn !== 'org-plane') return token;
  if (cachedHubAud && cachedHubAud.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) return cachedHubAud.token;
  return null;
}

/**
 * A token Superlibrary accepts for this person, or null: not signed in through the plane, a
 * workspace without Superlibrary, or the plane declined. Null is an ordinary answer: the drawer says so.
 */
export function libraryConfigured(): boolean {
  return !libraryAbsent;
}

export async function libraryToken(): Promise<string | null> {
  if (cachedLibrary && cachedLibrary.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) return cachedLibrary.token;
  if (libraryInFlight) return libraryInFlight;
  libraryInFlight = (async () => {
    try {
      const res = await hubTokenFetch('/hub/token?library=1');
      const body = (await res.json().catch(() => null)) as { libraryToken?: string | null; libraryConfigured?: boolean } | null;
      if (res.ok && body?.libraryConfigured === false) libraryAbsent = true;
      const t = res.ok ? (body?.libraryToken ?? null) : null;
      const exp = t ? expiryOf(t) : 0;
      cachedLibrary = t && exp > 0 ? { token: t, expiresAtMs: exp } : null;
      return cachedLibrary?.token ?? null;
    } catch {
      return null;
    } finally {
      libraryInFlight = null;
    }
  })();
  return libraryInFlight;
}

/** Drop only the library token (Superlibrary answered 401). */
export function forgetLibraryToken(): void {
  cachedLibrary = null;
}

/** Drop the cached token — after signing out, or when the hub rejects it. */
export function forgetHubToken(): void {
  cached = null;
  cachedHubAud = null;
  cachedLibrary = null;
  libraryAbsent = false;
  lastSignIn = null;
}

/**
 * Headers for a superpipeline request, carrying authority when there is any.
 *
 * The `Authorization` header is additive: superpipeline still reads its own session
 * cookie, and `resolveHubUser` only runs when the cookie path declines. This is
 * what lets a board with no hub issuer keep working unchanged.
 */
export async function withAuthority(headers: Record<string, string>): Promise<Record<string, string>> {
  const token = await hubToken();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

/**
 * What to say to somebody the sign-in flow sent home empty-handed.
 *
 * Signing in through AgentPod can succeed at the issuer and still resolve nobody here: the
 * person is authenticated, and superpipeline has no account linked to that identity. Until this
 * existed, `/hub/callback` redirected home either way, so a rejection and a misclick produced
 * the same screen — the landing page, again, with nothing on it to read.
 *
 * So the Worker names the outcome in the URL and this turns it into a sentence. See the
 * redirect in `apps/api/src/auth/hub-oauth.ts`, which writes the same two literals; they are
 * deliberately written twice rather than shared through a package, and both sides pin them in a
 * test. The cost of drift is a missing notice, which is what this file replaced.
 *
 * **Only outcomes this file knows about produce a notice.** An unrecognised value renders
 * nothing, because the alternative is showing a stranger's query string on a sign-in page.
 */

/** The query parameter `/hub/callback` sets on its way home. */
export const SIGNIN_PARAM = 'signin';

/**
 * Authenticated at the issuer, unknown here.
 *
 * One value, matching the one the Worker sends. The reasons the identity step declines — no
 * verified email, an address already linked to another principal, a fleet this deployment is
 * not connected to — are collapsed on purpose: telling a stranger which one applied answers
 * "does an account exist at this address?" for them.
 */
export const SIGNIN_NO_ACCOUNT = 'no-account';

/** A sentence and its heading, ready to render. */
export interface SignInNotice {
  title: string;
  detail: string;
}

/**
 * Read the outcome out of a query string, or null when there is nothing to say.
 *
 * Takes the search string rather than reading `location` so it is a pure function — which is
 * the only way anything on this side of the app gets tested, the web suite running in node.
 */
export function signInNotice(search: string): SignInNotice | null {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get(SIGNIN_PARAM);
  } catch {
    return null;
  }

  if (value === SIGNIN_NO_ACCOUNT) {
    return {
      title: 'Signed in with AgentPod, but not known here',
      detail:
        'That AgentPod identity is not linked to a superpipeline account. Sign in with GitHub if you already have one — the two link themselves once the addresses match — or ask someone who owns a workspace to invite you.',
    };
  }

  return null;
}

/**
 * The same URL with the outcome removed.
 *
 * Fed to `history.replaceState` so a reload does not re-assert a notice about a sign-in attempt
 * that happened once, minutes ago. Returns the path, search and hash only — a same-document
 * replace wants a relative URL, and handing it an absolute one is how an origin check starts
 * mattering.
 */
export function urlWithoutSignInParam(href: string): string {
  try {
    const u = new URL(href);
    u.searchParams.delete(SIGNIN_PARAM);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return href;
  }
}

/** What the landing page offers, given how this deployment signs people in. */
export interface SignInChoices {
  primary: { href: string; label: string };
  /** Whether to also offer the separate "Continue with AgentPod" door (hub mode only). */
  offerHubConnect: boolean;
}

/**
 * One door after the Organization-plane cutover — `/auth/login` goes to the plane, which is also
 * where an AgentPod identity lives — and the two doors of before while it has not happened.
 */
export function signInChoices(status: { configured: boolean; signIn: 'github' | 'org-plane' }): SignInChoices {
  return status.signIn === 'org-plane'
    ? { primary: { href: '/auth/login', label: 'Sign in' }, offerHubConnect: false }
    : { primary: { href: '/auth/login', label: 'Sign in with GitHub' }, offerHubConnect: status.configured };
}

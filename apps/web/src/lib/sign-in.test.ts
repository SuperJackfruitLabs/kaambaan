import { describe, it, expect } from 'vitest';
import { signInNotice, signInChoices, urlWithoutSignInParam, SIGNIN_PARAM, SIGNIN_NO_ACCOUNT } from './sign-in';

/**
 * The sentence a failed sign-in leaves behind.
 *
 * Signing in through AgentPod can succeed at the issuer and resolve nobody here. The Worker
 * redirects home either way; what tells the two apart is the outcome it writes into the URL
 * (`apps/api/src/auth/hub-oauth.ts`). Without it the landing page re-renders itself and a
 * rejection is indistinguishable from a misclick — which is the state this replaced.
 *
 * The literals are pinned here and on the Worker's side, because they are the contract between
 * the two and nothing in the type system connects them.
 */

describe('the literals the Worker writes', () => {
  it('are the ones the Worker writes', () => {
    // If either of these changes, `hub-oauth.ts`'s redirect has to change with it — and the test
    // there, which asserts the whole string `/?signin=no-account`, is the other half of this pair.
    expect(SIGNIN_PARAM).toBe('signin');
    expect(SIGNIN_NO_ACCOUNT).toBe('no-account');
  });
});

describe('signInNotice', () => {
  it('explains an identity the issuer knows and superpipeline does not', () => {
    const notice = signInNotice('?signin=no-account');
    expect(notice).not.toBeNull();
    expect(notice?.title).toMatch(/AgentPod/);
    expect(notice?.detail).toMatch(/GitHub/);
  });

  it('says nothing on an ordinary visit', () => {
    // Every first-time visitor lands here. A notice on a page nobody was sent to would be noise.
    expect(signInNotice('')).toBeNull();
    expect(signInNotice('?')).toBeNull();
  });

  it('says nothing about a value it does not recognise', () => {
    // The parameter is in a URL anybody can type. Rendering an unknown value would put a
    // stranger's text on our sign-in page, so unknown reads as nothing to say.
    expect(signInNotice('?signin=<script>')).toBeNull();
    expect(signInNotice('?signin=banned')).toBeNull();
    expect(signInNotice('?signin=')).toBeNull();
  });

  it('reads the outcome among other parameters', () => {
    expect(signInNotice('?ref=docs&signin=no-account&utm=x')).not.toBeNull();
  });
});

describe('urlWithoutSignInParam', () => {
  it('removes the outcome and keeps everything else', () => {
    expect(urlWithoutSignInParam('https://app.superpipeline.dev/?ref=docs&signin=no-account')).toBe('/?ref=docs');
  });

  it('returns a relative URL, never an absolute one', () => {
    // It is handed to `history.replaceState`, which is a same-document replace. Keeping it
    // relative is how the origin stays something nobody has to check.
    expect(urlWithoutSignInParam('https://app.superpipeline.dev/board/b1?signin=no-account#card')).toBe(
      '/board/b1#card',
    );
  });

  it('leaves a URL with no outcome in it alone', () => {
    expect(urlWithoutSignInParam('https://app.superpipeline.dev/')).toBe('/');
  });

  it('hands back what it was given rather than throwing on nonsense', () => {
    expect(urlWithoutSignInParam('not a url')).toBe('not a url');
  });
});

describe('signInChoices', () => {
  it('offers GitHub, plus the hub connect, before cutover', () => {
    expect(signInChoices({ configured: true, signIn: 'github' })).toEqual({
      primary: { href: '/auth/login', label: 'Sign in with GitHub' },
      offerHubConnect: true,
    });
  });

  it('offers one sign-in and no separate hub button in plane mode', () => {
    expect(signInChoices({ configured: true, signIn: 'org-plane' })).toEqual({
      primary: { href: '/auth/login', label: 'Sign in' },
      offerHubConnect: false,
    });
  });
});

describe('signInNotice, by sign-in mode', () => {
  const search = `?${SIGNIN_PARAM}=${SIGNIN_NO_ACCOUNT}`;

  it('keeps the GitHub wording in hub mode (the default)', () => {
    expect(signInNotice(search)?.detail).toContain('Sign in with GitHub');
    expect(signInNotice(search, 'github')?.detail).toContain('Sign in with GitHub');
  });

  it('never mentions GitHub in plane mode, and points at the one Sign in', () => {
    const n = signInNotice(search, 'org-plane');
    expect(n).not.toBeNull();
    expect(`${n!.title} ${n!.detail}`).not.toMatch(/github/i);
    expect(n!.detail).toContain('Sign in');
  });
});

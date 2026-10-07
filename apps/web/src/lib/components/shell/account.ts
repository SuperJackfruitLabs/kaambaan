import { logout } from '$lib/api';

/**
 * Sign out, from wherever the person is.
 *
 * One function because three places offer it — the rail, the phone's bottom-nav menu and the
 * command palette — and they must not drift: a reload after the session cookie is cleared is what
 * drops the app back to the landing page.
 */
export async function signOut(): Promise<void> {
  await logout();
  location.reload();
}

/** The name of the theme the toggle would switch TO — what the control does, not what is on. */
export function otherThemeLabel(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? 'Light theme' : 'Dark theme';
}

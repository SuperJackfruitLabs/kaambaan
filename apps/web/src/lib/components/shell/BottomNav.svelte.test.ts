// @vitest-environment jsdom
/**
 * The phone's navigation must reach the account.
 *
 * The 2026-10-07 responsive audit's one P1: sign-out and the theme toggle lived only in the rail,
 * which is not rendered below 900px. The bottom nav had three links and no menu, so on a phone or
 * a tablet there was no way to sign out at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/b/brd_1') } }));
const logout = vi.fn(async () => {});
vi.mock('$lib/api', async (orig) => ({ ...(await orig<typeof import('$lib/api')>()), logout: () => logout() }));

import BottomNav from './BottomNav.svelte';
import { app } from '$lib/stores/app.svelte';

describe('BottomNav', () => {
  beforeEach(() => {
    logout.mockClear();
    app.user = { id: 'usr_1', login: 'ada', name: 'Ada Lovelace', avatarUrl: null } as never;
    app.theme = 'dark';
    Object.defineProperty(window, 'location', { value: { ...window.location, reload: vi.fn() }, writable: true });
  });
  afterEach(() => cleanup());

  it('has a fourth destination for the account', () => {
    render(BottomNav);
    expect(screen.getByRole('button', { name: /you/i })).toBeTruthy();
  });

  it('opens a menu that signs out', async () => {
    render(BottomNav);
    await fireEvent.click(screen.getByRole('button', { name: /you/i }));
    await fireEvent.click(screen.getByRole('menuitem', { name: /sign out/i }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('opens a menu that switches the theme', async () => {
    render(BottomNav);
    await fireEvent.click(screen.getByRole('button', { name: /you/i }));
    await fireEvent.click(screen.getByRole('menuitem', { name: /light theme/i }));
    expect(app.theme).toBe('light');
  });

  it('names who is signed in', async () => {
    render(BottomNav);
    await fireEvent.click(screen.getByRole('button', { name: /you/i }));
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  });
});

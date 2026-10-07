// @vitest-environment jsdom
/**
 * The palette is the keyboard's way to everything, so it reaches the account too: sign out and
 * the theme were the two things a person below 900px could not get to at all (audit 2026-10-07).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
const logout = vi.fn(async () => {});
vi.mock('$lib/api', async (orig) => ({ ...(await orig<typeof import('$lib/api')>()), logout: () => logout() }));

import CommandPalette from './CommandPalette.svelte';
import { app } from '$lib/stores/app.svelte';

async function openWith(query: string) {
  render(CommandPalette);
  app.cmdkOpen = true;
  await tick();
  const input = screen.getByPlaceholderText(/jump to/i) as HTMLInputElement;
  await fireEvent.input(input, { target: { value: query } });
}

describe('CommandPalette account commands', () => {
  beforeEach(() => {
    logout.mockClear();
    app.theme = 'dark';
    app.cmdkOpen = false;
    Object.defineProperty(window, 'location', { value: { ...window.location, reload: vi.fn() }, writable: true });
  });
  afterEach(() => cleanup());

  it('signs out', async () => {
    await openWith('sign out');
    await fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('switches to the light theme from dark', async () => {
    await openWith('theme');
    await fireEvent.click(screen.getByRole('button', { name: /light theme/i }));
    expect(app.theme).toBe('light');
    expect(app.cmdkOpen).toBe(false);
  });

  it('offers the dark theme when light is on', async () => {
    app.theme = 'light';
    await openWith('theme');
    expect(screen.getByRole('button', { name: /dark theme/i })).toBeTruthy();
  });
});

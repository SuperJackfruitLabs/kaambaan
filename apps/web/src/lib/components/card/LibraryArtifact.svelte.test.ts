// apps/web/src/lib/components/card/LibraryArtifact.svelte.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';

const mount = vi.fn();
vi.mock('$lib/vendor/superlibrary-embed/superlibrary-embed.js', () => ({ mountArtifact: (...a: unknown[]) => mount(...a) }));
vi.mock('$lib/hub-token', () => ({ libraryToken: vi.fn(async () => 'lib-token'), forgetLibraryToken: vi.fn(), libraryConfigured: vi.fn(() => true) }));
import LibraryArtifact from './LibraryArtifact.svelte';
import { LibraryError } from '$lib/superlibrary';

afterEach(() => { cleanup(); mount.mockReset(); });

describe('LibraryArtifact (spec §9 Embedding, §11)', () => {
  it('LibraryArtifact mounts the embed with the person’s library token', async () => {
    const destroy = vi.fn();
    mount.mockResolvedValue({ destroy, setTheme: vi.fn(), setVersion: vi.fn(), iframe: document.createElement('iframe') });
    render(LibraryArtifact, { itemId: 'itm_0123456789abcdef', version: 3, title: 'Launch <b>post</b>', open: true });
    await waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
    const [, opts] = mount.mock.calls[0]!;
    expect(opts).toMatchObject({ itemId: 'itm_0123456789abcdef', version: 3, appUrl: 'https://app.superlibrary.dev' });
    expect(typeof opts.getEmbedUrl).toBe('function');
    expect(screen.getByRole('link', { name: 'Launch <b>post</b>' }).getAttribute('href')).toBe('https://app.superlibrary.dev/a/itm_0123456789abcdef/v/3');
    expect(document.querySelector('b')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Hide preview' }));
    expect(destroy).toHaveBeenCalled();
  });
  it('mounts nothing until asked, and a refusal is a sentence', async () => {
    mount.mockRejectedValue(new LibraryError(403, 'product_not_enabled'));
    render(LibraryArtifact, { itemId: 'itm_0123456789abcdef', title: 'Plan' });
    expect(mount).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Superlibrary is not enabled for this workspace.');
  });
  it('hiding the preview clears its failure message', async () => {
    mount.mockRejectedValue(new LibraryError(404, 'not_found'));
    render(LibraryArtifact, { itemId: 'itm_0123456789abcdef', title: 'Plan', open: true });
    expect(await screen.findByRole('alert')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Hide preview' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('aria-controls names the frame only while it exists', async () => {
    mount.mockResolvedValue({ destroy: vi.fn(), setTheme: vi.fn(), setVersion: vi.fn(), iframe: document.createElement('iframe') });
    render(LibraryArtifact, { itemId: 'itm_0123456789abcdef', title: 'Plan' });
    expect(screen.getByRole('button', { name: 'Show preview' }).hasAttribute('aria-controls')).toBe(false);
    await fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));
    const id = screen.getByRole('button', { name: 'Hide preview' }).getAttribute('aria-controls')!;
    expect(document.getElementById(id)).not.toBeNull();
  });
});

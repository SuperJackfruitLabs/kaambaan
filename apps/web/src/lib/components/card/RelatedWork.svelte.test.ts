// apps/web/src/lib/components/card/RelatedWork.svelte.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

const related = vi.fn();
vi.mock('$lib/superlibrary', async (orig) => ({ ...(await orig<typeof import('$lib/superlibrary')>()), relatedForCard: (id: string) => related(id) }));
vi.mock('$lib/hub-token', () => ({ libraryToken: vi.fn(async () => 'lib-token'), forgetLibraryToken: vi.fn() }));
import RelatedWork from './RelatedWork.svelte';
import { LibraryError } from '$lib/superlibrary';

afterEach(() => { cleanup(); related.mockReset(); });
const CARD = 'card_00000000000000c1';

describe('Related prior work (superlibrary spec §11)', () => {
  it('RelatedWork lists the card’s related items with their outcomes, and a snippet with markup is shown as text', async () => {
    related.mockResolvedValue([{ itemId: 'itm_0123456789abcdef', title: 'Last spring’s launch', kind: 'work-record', outcome: 'rejected', snippet: 'Too costly <img src=x onerror=alert(1)>', url: 'https://app.superlibrary.dev/a/itm_0123456789abcdef' }]);
    render(RelatedWork, { cardId: CARD });
    const link = await screen.findByRole('link', { name: 'Last spring’s launch' });
    expect(related).toHaveBeenCalledWith(CARD);
    expect(link.getAttribute('href')).toBe('https://app.superlibrary.dev/a/itm_0123456789abcdef');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('Too costly <img src=x onerror=alert(1)>');
  });
  it('says when there is nothing, and when Superlibrary is not available, with a retry', async () => {
    related.mockResolvedValueOnce([]);
    render(RelatedWork, { cardId: CARD });
    expect(await screen.findByText('Nothing related in Superlibrary yet.')).toBeTruthy();
    cleanup();
    related.mockRejectedValueOnce(new LibraryError(0, 'no_token')).mockResolvedValueOnce([]);
    render(RelatedWork, { cardId: CARD });
    expect(await screen.findByText(/Previews need you signed in/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing related in Superlibrary yet.')).toBeTruthy();
  });
  it('a result whose link is not on the library is shown without a link', async () => {
    related.mockResolvedValue([{ itemId: 'itm_0123456789abcdef', title: 'Odd', kind: 'artifact', outcome: 'completed', snippet: '', url: 'https://evil.test/a/itm_0123456789abcdef' }]);
    render(RelatedWork, { cardId: CARD });
    expect(await screen.findByText('Odd')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Odd' })).toBeNull();
  });
  it('an empty title falls back to the item id, so the link is never invisible', async () => {
    related.mockResolvedValue([{ itemId: 'itm_0123456789abcdef', title: '', kind: 'artifact', outcome: 'completed', snippet: '', url: 'https://app.superlibrary.dev/a/itm_0123456789abcdef' }]);
    render(RelatedWork, { cardId: CARD });
    expect(await screen.findByRole('link', { name: 'itm_0123456789abcdef' })).toBeTruthy();
  });
});

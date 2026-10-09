// apps/web/src/lib/superlibrary.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/hub-token', () => ({ libraryToken: vi.fn(async () => 'lib-token'), forgetLibraryToken: vi.fn() }));
import { forgetLibraryToken, libraryToken } from '$lib/hub-token';
import { LibraryError, embedCallbacks, libraryRef, sentenceFor } from './superlibrary';

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(libraryToken).mockResolvedValue('lib-token'); });

describe('Superlibrary references (spec §11: the drawer previews linked artifacts)', () => {
  it('libraryRef reads an item link on the library, with its version', () => {
    expect(libraryRef('https://app.superlibrary.dev/a/itm_0123456789abcdef')).toEqual({ itemId: 'itm_0123456789abcdef' });
    expect(libraryRef('https://app.superlibrary.dev/a/itm_0123456789abcdef/v/3')).toEqual({ itemId: 'itm_0123456789abcdef', version: 3 });
    expect(libraryRef('http://app.superlibrary.dev/a/itm_0123456789abcdef')).toBeNull();
    expect(libraryRef('https://app.superlibrary.dev.evil.test/a/itm_0123456789abcdef')).toBeNull();
    expect(libraryRef('https://app.superlibrary.dev/upload')).toBeNull();
    expect(libraryRef('not a url')).toBeNull();
  });
  it('calls Superlibrary with the person’s own library token, never cookies', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json({ url: 'https://itm-x.superlibrarycontent.dev/_view?sig=s', version: 2 }); }));
    await embedCallbacks().getEmbedUrl({ itemId: 'itm_0123456789abcdef', version: 2 });
    expect(calls[0]!.url).toBe('https://app.superlibrary.dev/api/v1/items/itm_0123456789abcdef/embed');
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer lib-token');
    expect(calls[0]!.init.credentials).toBe('omit');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ version: 2 });
  });
  it('a 401 drops the library token; no token is a refusal in words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unauthenticated' }, { status: 401 })));
    await expect(embedCallbacks().getEmbedUrl({ itemId: 'itm_0123456789abcdef' })).rejects.toBeInstanceOf(LibraryError);
    expect(forgetLibraryToken).toHaveBeenCalled();
    vi.mocked(libraryToken).mockResolvedValue(null);
    await expect(embedCallbacks().getEmbedUrl({ itemId: 'itm_0123456789abcdef' })).rejects.toMatchObject({ code: 'no_token' });
    expect(sentenceFor(new LibraryError(0, 'no_token'))).toBe('Previews need you signed in through your workspace account.');
    expect(sentenceFor(new LibraryError(403, 'product_not_enabled'))).toBe('Superlibrary is not enabled for this workspace.');
    expect(sentenceFor(new LibraryError(404, 'not_found'))).toBe('This artifact is not there, or you cannot see it.');
  });
  it('one mount reads the item once for its versions and its share info', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/api/v1/me')) return Response.json({ principalId: 'prn_000000000000000000a2', role: 'member' });
      return Response.json({ item: { scope: 'workspace', title: 'T', createdBy: 'prn_000000000000000000a2' }, versions: [{ version: 1, revokedAt: null }] });
    }));
    const cb = embedCallbacks();
    await cb.getVersions({ itemId: 'itm_0123456789abcdef' });
    await cb.getShareInfo({ itemId: 'itm_0123456789abcdef' });
    expect(urls.filter((u) => u.endsWith('/api/v1/items/itm_0123456789abcdef'))).toHaveLength(1);
  });
});

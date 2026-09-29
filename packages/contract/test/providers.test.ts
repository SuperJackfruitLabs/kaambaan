import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  isKnownProvider,
  providerKeys,
  verificationKindOf,
  recognise,
} from '../src/providers';

/**
 * The registry that replaces a closed enum nothing parsed.
 *
 * `ReferenceProvider` named five providers and was never checked at a write boundary — the routes
 * cast request bodies rather than parsing them — so on 2026-09-28 `provider: "web"` was written to
 * a live card and stored. The vocabulary was simultaneously too narrow (no Drive, Notion, Figma,
 * Sentry) and not enforced, which is the worst pair: the narrowness is visible and the
 * non-enforcement is not.
 */
describe('the registry', () => {
  it('is the single list, and `url` is always in it as the fallback', () => {
    expect(providerKeys()).toContain('url');
    expect(isKnownProvider('url')).toBe(true);
  });

  it('carries `docs` as declarable — a caller may name it, no host identifies it', () => {
    // Removing it broke a test asserting a caller may pass it explicitly, which was right: `docs`
    // is a claim about a link's ROLE, not about where it lives. Any host can serve a document.
    // Drive, Notion and Figma arrive the same way, before anybody writes them a recogniser.
    expect(isKnownProvider('docs')).toBe(true);
    expect(recognise('https://example.test/a-design-doc')).toMatchObject({ provider: 'url' });
    expect(verificationKindOf('docs')).toBe('none');
  });

  it('refuses a provider nobody registered — the hole `"web"` went through', () => {
    expect(isKnownProvider('web')).toBe(false);
    expect(isKnownProvider('')).toBe(false);
  });

  it('gives every provider a verification kind, because permission is not meaning', () => {
    // A provider with no declared kind would default to *something*, and every default here is
    // wrong: `fetch` invents permission, `none` silently stops checking what could be checked.
    for (const p of PROVIDERS) {
      expect(['fetch', 'api', 'none'], `${p.key} has no verification kind`).toContain(p.verification);
    }
  });

  it('marks the generic provider unverifiable, since it names no host at all', () => {
    expect(verificationKindOf('url')).toBe('none');
  });

  it('answers `none` for a provider it does not know, rather than throwing at a caller', () => {
    expect(verificationKindOf('web')).toBe('none');
  });
});

describe('recognise', () => {
  it('reads a GitHub pull request', () => {
    expect(recognise('https://github.com/org/repo/pull/42')).toEqual({
      provider: 'github',
      sourceType: 'pull_request',
      externalId: 'org/repo#42',
    });
  });

  it('reads a forge pull request only when told which host is the forge', () => {
    const url = 'https://forge.example.test/org/repo/pulls/7';
    expect(recognise(url)).toMatchObject({ provider: 'url' });
    expect(recognise(url, { forgeHost: 'forge.example.test' })).toEqual({
      provider: 'forge',
      sourceType: 'pull_request',
      externalId: 'org/repo#7',
    });
  });

  it('keeps Forgejo’s own spellings — `pulls`, and a branch under `src/branch`', () => {
    const at = (path: string) =>
      recognise(`https://f.test${path}`, { forgeHost: 'f.test' });
    expect(at('/o/r/pulls/1')).toMatchObject({ sourceType: 'pull_request' });
    expect(at('/o/r/src/branch/main')).toMatchObject({ sourceType: 'branch', externalId: 'o/r@main' });
  });

  it('falls back to the generic provider rather than guessing', () => {
    expect(recognise('https://notion.so/some-page')).toMatchObject({ provider: 'url', sourceType: 'url' });
    expect(recognise('not a url at all')).toMatchObject({ provider: 'url' });
  });

  it('is not fooled by a host that merely ends with the forge host', () => {
    expect(recognise('https://not-f.test/o/r/pulls/1', { forgeHost: 'f.test' })).toMatchObject({
      provider: 'url',
    });
  });
});

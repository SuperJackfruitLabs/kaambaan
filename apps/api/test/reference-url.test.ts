import { describe, it, expect } from 'vitest';
import { recognizeReference } from '../src/references/reference-url';

/** docs/06 §1: recognized URL shapes get richer provider/sourceType; a bare url is still valid. */
describe('recognizeReference', () => {
  it('recognizes a GitHub pull request URL', () => {
    expect(recognizeReference('https://github.com/org/repo/pull/42')).toEqual({
      provider: 'github',
      sourceType: 'pull_request',
      externalId: 'org/repo#42',
    });
  });

  it('recognizes a GitHub issue URL', () => {
    expect(recognizeReference('https://github.com/org/repo/issues/7')).toEqual({
      provider: 'github',
      sourceType: 'issue',
      externalId: 'org/repo#7',
    });
  });

  it('recognizes a GitHub repository URL', () => {
    expect(recognizeReference('https://github.com/org/repo')).toEqual({
      provider: 'github',
      sourceType: 'repo',
      externalId: 'org/repo',
    });
  });

  it('recognizes a GitHub commit URL', () => {
    expect(recognizeReference('https://github.com/org/repo/commit/abc123')).toMatchObject({
      provider: 'github',
      sourceType: 'commit',
    });
  });

  it('tolerates trailing slashes and query strings', () => {
    expect(recognizeReference('https://github.com/org/repo/pull/42/')).toMatchObject({
      sourceType: 'pull_request',
      externalId: 'org/repo#42',
    });
    expect(recognizeReference('https://github.com/org/repo/pull/42?w=1')).toMatchObject({ sourceType: 'pull_request' });
  });

  it('falls back to a generic url reference for non-GitHub links', () => {
    expect(recognizeReference('https://docs.example.com/spec')).toEqual({ provider: 'url', sourceType: 'url' });
  });

  it('falls back gracefully for an unparseable string', () => {
    expect(recognizeReference('not a url')).toEqual({ provider: 'url', sourceType: 'url' });
  });
});

/**
 * A self-hosted forge.
 *
 * GitHub can be recognised from a constant because there is one github.com. A Forgejo instance
 * is at whatever host its operator chose, so recognition has to be TOLD, and a caller that does
 * not know stays exactly as it was — a generic `url`, never a guess.
 *
 * The URL shapes are close to GitHub's and differ in two places that matter: Forgejo pluralises
 * `pulls` and puts a branch under `src/branch`. Assuming GitHub's spellings would file a pull
 * request as an unmodelled page.
 */
describe('recognizeReference on a configured forge', () => {
  const FORGE = 'forge.example.test';

  it('recognizes a pull request, which Forgejo spells `pulls`', () => {
    expect(recognizeReference(`https://${FORGE}/org/repo/pulls/42`, FORGE)).toEqual({
      provider: 'forge',
      sourceType: 'pull_request',
      externalId: 'org/repo#42',
    });
  });

  it('recognizes an issue, a repo and a commit', () => {
    expect(recognizeReference(`https://${FORGE}/org/repo/issues/7`, FORGE)).toMatchObject({
      provider: 'forge',
      sourceType: 'issue',
      externalId: 'org/repo#7',
    });
    expect(recognizeReference(`https://${FORGE}/org/repo`, FORGE)).toMatchObject({
      provider: 'forge',
      sourceType: 'repo',
      externalId: 'org/repo',
    });
    expect(recognizeReference(`https://${FORGE}/org/repo/commit/abc123`, FORGE)).toMatchObject({
      provider: 'forge',
      sourceType: 'commit',
      externalId: 'org/repo@abc123',
    });
  });

  it('recognizes a branch, which Forgejo puts under `src/branch`', () => {
    expect(recognizeReference(`https://${FORGE}/org/repo/src/branch/main`, FORGE)).toMatchObject({
      provider: 'forge',
      sourceType: 'branch',
      externalId: 'org/repo@main',
    });
  });

  it('is generic when no forge is configured — it never guesses at a host', () => {
    // The whole reason recognition takes a parameter. A tenant with no forge must not have
    // arbitrary self-hosted URLs relabelled as theirs.
    expect(recognizeReference(`https://${FORGE}/org/repo/pulls/42`)).toEqual({
      provider: 'url',
      sourceType: 'url',
    });
  });

  it('still recognizes GitHub when a forge is configured', () => {
    expect(recognizeReference('https://github.com/org/repo/pull/42', FORGE)).toMatchObject({
      provider: 'github',
      sourceType: 'pull_request',
    });
  });

  it('is not fooled by a lookalike host', () => {
    expect(recognizeReference(`https://not-${FORGE}/org/repo/pulls/1`, FORGE)).toEqual({
      provider: 'url',
      sourceType: 'url',
    });
  });
});

/**
 * URL-level behaviour, pinned where the real parser runs.
 *
 * The contract package holds the rules and takes an already-parsed host, because it compiles with
 * no DOM and no Node types. The parse lives here — and the host comparison it feeds is a security
 * boundary, so these exist to prove the platform's parser is doing that job rather than a regex.
 */
describe('recognizeReference parses before it matches', () => {
  it('is not fooled by userinfo naming the forge', () => {
    // `https://evil.com@forge.example.test/` has hostname `forge.example.test` — the userinfo is
    // `evil.com` and belongs to nobody. The inverse is the dangerous one and is the point of this
    // test: a hand-rolled split on `//` and `/` reads the host as `evil.com` in one direction and
    // as the operator's forge in the other. A real parser is not confused either way.
    expect(
      recognizeReference('https://forge.example.test@evil.test/org/repo/pulls/1', 'forge.example.test'),
    ).toMatchObject({ provider: 'url' });
  });

  it('ignores a port and a query when matching the host', () => {
    expect(
      recognizeReference('https://forge.example.test/org/repo/pulls/1?tab=files', 'forge.example.test'),
    ).toMatchObject({ provider: 'forge', externalId: 'org/repo#1' });
  });

  it('answers generic for something that is not a url at all', () => {
    expect(recognizeReference('not a url at all')).toEqual({ provider: 'url', sourceType: 'url' });
  });
});

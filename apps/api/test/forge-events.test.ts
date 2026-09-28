/**
 * Forgejo's webhook vocabulary, which is GitHub's until it isn't.
 *
 * The payload SHAPES match closely enough to be tempting — `repository.full_name`,
 * `pull_request.number`, `action` — and the action VALUES do not. Forgejo's own constants
 * (`modules/structs/hook.go`) spell the update action `synchronized`, where GitHub sends
 * `synchronize`, and Forgejo has no `ready_for_review` or `converted_to_draft` at all.
 *
 * Reusing the GitHub mapper would therefore drop the single most common pull-request event on
 * the floor, silently, while appearing to work for `opened` and `closed`.
 */
import { describe, it, expect } from 'vitest';
import { mapForgeEvent } from '../src/references/forge-events';
import { mapGithubEvent } from '../src/references/github-events';

const pr = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  repository: { full_name: 'Org/Repo', default_branch: 'main' },
  pull_request: {
    number: 7,
    state: 'open',
    html_url: 'https://forge.example.test/org/repo/pulls/7',
    base: { ref: 'main' },
    head: { ref: 'feat/x' },
    ...extra,
  },
});

describe('mapForgeEvent', () => {
  it('maps `synchronized`, the spelling GitHub does not use', () => {
    // The regression this file exists for.
    expect(mapForgeEvent('pull_request', pr('synchronized'))).toMatchObject({
      externalId: 'org/repo#7',
      sourceType: 'pull_request',
      subState: 'agent_iterating',
    });
    // And the proof that borrowing the other mapper would have lost it.
    expect(mapGithubEvent('pull_request', pr('synchronized'))).toBeNull();
  });

  it('maps opened, reopened and closed', () => {
    expect(mapForgeEvent('pull_request', pr('opened'))).toMatchObject({ subState: 'pr_open' });
    expect(mapForgeEvent('pull_request', pr('reopened'))).toMatchObject({ subState: 'pr_open' });
    expect(mapForgeEvent('pull_request', pr('closed'))).toMatchObject({ subState: 'closed' });
  });

  it('records a merge, and whether it landed on the default branch', () => {
    const merged = mapForgeEvent('pull_request', pr('closed', { merged: true }));
    expect(merged).toMatchObject({ subState: 'merged' });
    expect(merged!.metadata).toMatchObject({ merged: true, mergedToDefaultBranch: true });

    const sideways = mapForgeEvent('pull_request', pr('closed', { merged: true, base: { ref: 'release' } }));
    expect(sideways!.metadata).toMatchObject({ mergedToDefaultBranch: false });
  });

  it('treats a draft pull request as a draft when the payload says so', () => {
    expect(mapForgeEvent('pull_request', pr('opened', { draft: true }))).toMatchObject({
      subState: 'draft_pr_open',
    });
  });

  it('maps issues, and lowercases the repository the way references store it', () => {
    expect(mapForgeEvent('issues', {
      action: 'opened',
      repository: { full_name: 'Org/Repo' },
      issue: { number: 3, state: 'open', html_url: 'https://forge.example.test/org/repo/issues/3' },
    })).toMatchObject({ externalId: 'org/repo#3', sourceType: 'issue' });
  });

  it('returns null for what it does not model, rather than guessing', () => {
    expect(mapForgeEvent('pull_request', pr('label_updated'))).toBeNull();
    expect(mapForgeEvent('push', { repository: { full_name: 'org/repo' } })).toBeNull();
    expect(mapForgeEvent('pull_request', { action: 'opened' })).toBeNull();
  });
});

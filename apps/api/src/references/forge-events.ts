/**
 * Translate a Forgejo webhook into a sub-state + metadata patch, the way `github-events.ts` does
 * for GitHub. Pure and total: null for anything not modelled.
 *
 * ## Why this is not `mapGithubEvent` with a different name
 *
 * Forgejo's payload SHAPES match GitHub's closely enough to be tempting — `repository.full_name`,
 * `pull_request.number`, an `action` string — and its action VALUES do not. Forgejo's own
 * constants (`modules/structs/hook.go`) spell the update action **`synchronized`**, where GitHub
 * sends `synchronize`, and Forgejo has no `ready_for_review` or `converted_to_draft` at all.
 *
 * Borrowing the GitHub mapper would therefore drop the single most common pull-request event on
 * the floor — silently, while still appearing to work for `opened` and `closed`, which is the
 * worst way for a difference like this to be wrong.
 *
 * The sub-states are deliberately the SAME vocabulary the GitHub mapper produces. A card does not
 * care which forge its pull request is on, and a second set of names would make every consumer
 * ask.
 */
import type { GithubEventResult } from './github-events';

interface Repo {
  full_name?: string;
  default_branch?: string;
}

export function mapForgeEvent(event: string, payload: unknown): GithubEventResult | null {
  const p = payload as Record<string, any>;
  const repo = (p.repository ?? {}) as Repo;
  const fullName = repo.full_name?.toLowerCase();
  if (!fullName) return null;

  if (event === 'pull_request') {
    const pr = p.pull_request as Record<string, any> | undefined;
    if (!pr || typeof pr.number !== 'number') return null;
    const base = { externalId: `${fullName}#${pr.number}`, sourceType: 'pull_request' as const };
    const meta = (extra: Record<string, unknown>): Record<string, unknown> => ({
      state: pr.state,
      draft: !!pr.draft,
      baseRef: pr.base?.ref,
      headRef: pr.head?.ref,
      url: pr.html_url,
      ...extra,
    });

    switch (p.action) {
      case 'opened':
      case 'reopened':
        return { ...base, subState: pr.draft ? 'draft_pr_open' : 'pr_open', metadata: meta({}) };
      // Forgejo's spelling. GitHub's `synchronize` is deliberately NOT accepted here: this
      // endpoint speaks to a forge, and quietly taking both would hide a payload arriving from
      // somewhere other than the one configured.
      case 'synchronized':
        return { ...base, subState: 'agent_iterating', metadata: meta({}) };
      case 'closed':
        return pr.merged
          ? {
              ...base,
              subState: 'merged',
              metadata: meta({ merged: true, mergedToDefaultBranch: pr.base?.ref === repo.default_branch }),
            }
          : { ...base, subState: 'closed', metadata: meta({ merged: false }) };
      default:
        // `label_updated`, `assigned`, `reviewed`, `milestoned` and the rest: real Forgejo actions
        // that say nothing about the sub-state this models.
        return null;
    }
  }

  if (event === 'issues') {
    const issue = p.issue as Record<string, any> | undefined;
    if (!issue || typeof issue.number !== 'number') return null;
    const base = { externalId: `${fullName}#${issue.number}`, sourceType: 'issue' as const };
    const metadata = { state: issue.state, url: issue.html_url };
    switch (p.action) {
      case 'opened':
      case 'reopened':
        return { ...base, subState: 'issue_open', metadata };
      case 'closed':
        return { ...base, subState: 'issue_closed', metadata };
      default:
        return null;
    }
  }

  return null;
}

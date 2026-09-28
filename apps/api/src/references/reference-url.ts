/**
 * Recognize the shape of a reference URL (docs/06 §1). A recognised PR/issue/repo/commit URL gets
 * a richer `provider`/`sourceType` and a durable `externalId` (`owner/repo#n`); anything else is a
 * valid generic `url` reference — Superpipeline is domain-agnostic, references aren't git-specific.
 *
 * **GitHub is a constant; a forge is configuration.** There is one github.com, so its host can be
 * hardcoded. A Forgejo instance lives at whatever host its operator chose, so this has to be TOLD
 * which host is a forge, and treats every other self-hosted URL as generic. Guessing would relabel
 * an unrelated link as a tenant's own repository, which is worse than not recognising it at all.
 */
export interface RecognizedReference {
  provider: string;
  sourceType: string;
  externalId?: string;
}

const GENERIC: RecognizedReference = { provider: 'url', sourceType: 'url' };

/**
 * A Forgejo path, which is GitHub's with two differences that matter.
 *
 * Forgejo pluralises `pulls` and puts a branch under `src/branch/<name>`. Reusing GitHub's
 * spellings would file a forge pull request as an unmodelled page — recognised as the right
 * provider and the wrong thing, which is harder to notice than not recognising it.
 */
function recognizeForgePath(owner: string, repo: string, path: string[]): RecognizedReference {
  const slug = `${owner}/${repo}`.toLowerCase();
  const [kind, ...rest] = path;
  const id = rest[0];

  if (!kind) return { provider: 'forge', sourceType: 'repo', externalId: slug };
  if (kind === 'pulls' && id) return { provider: 'forge', sourceType: 'pull_request', externalId: `${slug}#${id}` };
  if (kind === 'issues' && id) return { provider: 'forge', sourceType: 'issue', externalId: `${slug}#${id}` };
  if (kind === 'commit' && id) return { provider: 'forge', sourceType: 'commit', externalId: `${slug}@${id}` };
  // `src/branch/main`, `src/tag/v1` — the ref kind is the second segment and the name the third.
  if (kind === 'src' && rest[0] === 'branch' && rest[1]) {
    return { provider: 'forge', sourceType: 'branch', externalId: `${slug}@${rest[1]}` };
  }

  // A forge URL we don't specifically model (e.g. /releases, /wiki).
  return { provider: 'forge', sourceType: 'url' };
}

export function recognizeReference(url: string, forgeHost?: string | null): RecognizedReference {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return GENERIC;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const forge = forgeHost?.trim().toLowerCase().replace(/^www\./, '') || null;
  // Exact match, never a suffix test: `not-forge.example.test` ends with the configured host and
  // belongs to somebody else.
  const provider = host === 'github.com' ? 'github' : forge && host === forge ? 'forge' : null;
  if (!provider) return GENERIC;

  const [owner, repo, ...path] = parsed.pathname.split('/').filter(Boolean);
  if (!owner || !repo) return { provider, sourceType: 'url' };
  if (provider === 'forge') return recognizeForgePath(owner, repo, path);

  const [kind, id] = path;
  // GitHub owner/repo are case-insensitive; normalize so an externalId from a mixed-case URL still
  // matches the canonical `repository.full_name` a webhook delivers (docs/06 §3).
  const slug = `${owner}/${repo}`.toLowerCase();

  if (!kind) return { provider: 'github', sourceType: 'repo', externalId: slug };
  if (kind === 'pull' && id) return { provider: 'github', sourceType: 'pull_request', externalId: `${slug}#${id}` };
  if (kind === 'issues' && id) return { provider: 'github', sourceType: 'issue', externalId: `${slug}#${id}` };
  if (kind === 'commit' && id) return { provider: 'github', sourceType: 'commit', externalId: `${slug}@${id}` };
  if ((kind === 'tree' || kind === 'blob') && id) return { provider: 'github', sourceType: 'branch', externalId: `${slug}@${id}` };

  // A github.com URL we don't specifically model (e.g. /actions, /wiki).
  return { provider: 'github', sourceType: 'url' };
}

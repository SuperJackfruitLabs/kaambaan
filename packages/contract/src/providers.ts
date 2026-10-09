/**
 * Where a reference can live, and whether the board can check that it is there.
 *
 * ## Why a registry and not the enum it replaces
 *
 * `ReferenceProvider` was `z.enum(['github', 'gitlab', 'forge', 'docs', 'url'])` and **nothing
 * parsed it**. It was imported by `verbs.ts` and `entities.ts` while the API routes cast request
 * bodies rather than parsing them, so on 2026-09-28 `provider: "web"` was written to a live card
 * and stored. The vocabulary was at once too narrow — no Drive, Notion, Figma, Sentry, the things
 * an operator actually references — and not enforced. That is the worse of the two pairs: the
 * narrowness is visible to everybody and the non-enforcement is visible to nobody.
 *
 * This is the one place a provider is added. Recognition, and the question of whether a live check
 * means anything, both read from here.
 *
 * ## Permission is not the same question as meaning
 *
 * A Google Doc or a Notion page fetched without credentials answers with a login page, frequently
 * with status **200**. A Drive file deleted last week would still "verify". So a provider declares
 * what a check against it would PROVE, not merely whether we are allowed to try:
 *
 * - `fetch` — an unauthenticated GET genuinely shows the artefact is there
 * - `api`   — nothing can be known without a credential; the board must say so rather than guess
 * - `none`  — the provider names no host we can reason about
 *
 * Only `fetch` is ever checked, and then only against an allowlist (see the design spec). `api`
 * exists here so the board can answer "not checked, and here is why" instead of `completed`;
 * building it is OAuth per provider and stored credentials, and is deliberately out of scope.
 */

export type VerificationKind = 'fetch' | 'api' | 'none';

export interface RecognisedReference {
  provider: string;
  sourceType: string;
  externalId?: string;
}

export interface ProviderContext {
  /** The tenant's Forgejo host. A self-hosted forge is wherever its operator put it. */
  forgeHost?: string | null;
}

export interface ProviderDef {
  key: string;
  /** What a live check against this provider would prove. */
  verification: VerificationKind;
  /**
   * Whether a caller may name this provider without the registry recognising it from a host.
   *
   * Two kinds live here. Most are RECOGNISED — a host identifies them, and a caller naming one is
   * confirming what the registry would have worked out. A few are DECLARED: they own no host,
   * because any host can serve the thing, and only the caller knows what it is. `docs` is the
   * first: "this card references a design document" is a claim about the link's role, not about
   * where it lives.
   *
   * Drive, Notion and Figma arrive here as declared providers before anybody writes a recogniser
   * for them, which is a better first step than leaving them as generic `url`.
   */
  declarable?: true;
  /** Whether this provider owns the host, given the tenant's configuration. */
  owns(host: string, ctx: ProviderContext): boolean;
  /** The shape of a path this provider owns. `null` means "mine, but not a shape I model". */
  read(segments: string[]): Omit<RecognisedReference, 'provider'> | null;
}

/** `owner/repo` lowercased — ids are compared against what a webhook delivers. */
const slug = (o: string, r: string): string => `${o}/${r}`.toLowerCase();

/** GitHub and Forgejo agree on everything here except two spellings; this is the shared part. */
function repoShapes(
  segments: string[],
  spell: { pull: string; branchAt: (rest: string[]) => string | null },
): Omit<RecognisedReference, 'provider'> | null {
  const [owner, repo, kind, ...rest] = segments;
  if (!owner || !repo) return { sourceType: 'url' };
  const s = slug(owner, repo);
  const id = rest[0];

  if (!kind) return { sourceType: 'repo', externalId: s };
  if (kind === spell.pull && id) return { sourceType: 'pull_request', externalId: `${s}#${id}` };
  if (kind === 'issues' && id) return { sourceType: 'issue', externalId: `${s}#${id}` };
  if (kind === 'commit' && id) return { sourceType: 'commit', externalId: `${s}@${id}` };

  const branch = spell.branchAt([kind, ...rest]);
  if (branch) return { sourceType: 'branch', externalId: `${s}@${branch}` };

  return { sourceType: 'url' };
}

/** `itm_` + 16 hex, optionally followed by `/v/<n>`: the shapes of a Superlibrary item link. */
const SUPERLIBRARY_ITEM = /^itm_[0-9a-f]{16}$/;

export const PROVIDERS: ProviderDef[] = [
  {
    key: 'superlibrary',
    verification: 'none',
    owns: (host) => host === 'app.superlibrary.dev',
    read: (segments) => {
      const [a, id, v, n, ...rest] = segments;
      if (a !== 'a' || !id || !SUPERLIBRARY_ITEM.test(id)) return null;
      if (v === undefined && n === undefined) return { sourceType: 'artifact', externalId: id };
      if (v === 'v' && n !== undefined && rest.length === 0 && /^[1-9][0-9]*$/.test(n)) return { sourceType: 'artifact', externalId: id };
      return null;
    },
  },
  {
    key: 'github',
    // Raw and API hosts are recognised as `github` too: a reference to a raw file is a reference
    // to the same repository, and splitting them would make two ids for one thing.
    verification: 'fetch',
    owns: (host) => host === 'github.com' || host === 'raw.githubusercontent.com' || host === 'api.github.com',
    read: (segments) =>
      repoShapes(segments, {
        pull: 'pull',
        branchAt: ([kind, id]) => ((kind === 'tree' || kind === 'blob') && id ? id : null),
      }),
  },
  {
    key: 'gitlab',
    verification: 'fetch',
    owns: (host) => host === 'gitlab.com',
    read: (segments) => repoShapes(segments, { pull: 'merge_requests', branchAt: () => null }),
  },
  {
    key: 'forge',
    // Exact match against the CONFIGURED host, never a suffix test: `not-forge.example.com` ends
    // with the operator's host and belongs to somebody else.
    verification: 'fetch',
    owns: (host, ctx) => {
      const forge = ctx.forgeHost?.trim().toLowerCase().replace(/^www\./, '');
      return !!forge && host === forge;
    },
    read: (segments) =>
      repoShapes(segments, {
        // Forgejo pluralises `pulls` and puts a branch under `src/branch/<name>`. Reusing GitHub's
        // spellings files a forge pull request as an unmodelled page — the right provider and the
        // wrong thing, which is harder to notice than no recognition at all.
        pull: 'pulls',
        branchAt: (rest) => (rest[0] === 'src' && rest[1] === 'branch' && rest[2] ? rest[2] : null),
      }),
  },
];

/** The fallback. It owns no host, so nothing about it can be checked. */
/**
 * Providers a caller may name that own no host.
 *
 * Removing `docs` from the registry broke a test asserting that a caller may pass it explicitly —
 * which was right, and the spec's claim that `docs` is "consumed by nothing" was half wrong. It is
 * produced by no recogniser, and deliberately declared by callers. Those are different things.
 */
export const DECLARED_ONLY: ProviderDef[] = [
  { key: 'docs', verification: 'none', declarable: true, owns: () => false, read: () => null },
];

/** The fallback. It owns no host, so nothing about it can be checked. */
export const GENERIC: RecognisedReference = { provider: 'url', sourceType: 'url' };

export function providerKeys(): string[] {
  return [...PROVIDERS.map((p) => p.key), ...DECLARED_ONLY.map((p) => p.key), GENERIC.provider];
}

export function isKnownProvider(key: string): boolean {
  return key !== '' && providerKeys().includes(key);
}

/**
 * What a live check against this provider would prove.
 *
 * An unregistered provider answers `none` rather than throwing: the registry is consulted on a
 * read path that may meet rows written before it existed — `web` is stored on a live card — and a
 * reader should get "we cannot check that" instead of an exception.
 */
export function verificationKindOf(key: string): VerificationKind {
  return [...PROVIDERS, ...DECLARED_ONLY].find((p) => p.key === key)?.verification ?? 'none';
}

/**
 * Recognise an ALREADY-PARSED url.
 *
 * This package compiles with `lib: ["ES2023"]` and `types: []` — no DOM, no Node — and nothing
 * else in it reaches for a runtime global. Widening that for one function would trade a real
 * property of the package (it compiles anywhere) for a convenience.
 *
 * Hand-rolling the parse instead would be worse. The host comparison here is a security boundary,
 * and a naive split makes `https://evil.com@forge.example.test/` look like the operator's forge —
 * userinfo confusion is not a thing to reimplement. So the platform's parser does the parsing, and
 * the rules live here.
 *
 * `host` must already be lowercased with any leading `www.` removed; `segments` is the path split
 * on `/` with empties dropped. `apps/api/src/references/reference-url.ts` is the adapter.
 */
export function recogniseParts(
  host: string,
  segments: string[],
  ctx: ProviderContext = {},
): RecognisedReference {
  const provider = PROVIDERS.find((p) => p.owns(host, ctx));
  if (!provider) return GENERIC;
  const read = provider.read(segments);
  return read ? { provider: provider.key, ...read } : { provider: provider.key, sourceType: 'url' };
}

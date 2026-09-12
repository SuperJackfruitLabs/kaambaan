/**
 * Documentation the code can contradict.
 *
 * See README.md for why this package exists and what it deliberately cannot check.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS = join(REPO, 'docs');

const docFiles = readdirSync(DOCS).filter((f) => f.endsWith('.md'));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const allDocs = () => docFiles.map((f) => ({ file: f, text: readFileSync(join(DOCS, f), 'utf8') }));

/**
 * The PUBLISHED pages, held to the same standard as the internal ones.
 *
 * Publishing doubles the surface that can go stale. If only the internal docs are checked, the
 * fraction of documentation anything verifies HALVES the day the site goes live — and the
 * published pages are the ones strangers read.
 *
 * `apps/landing` in AgentPod is the warning, recorded in its own README: both of its two outbound
 * links were 404s, because they were "ordinary links with no test behind them".
 */
const SITE = join(REPO, 'docs-site/src/content/docs');

function publishedPages(dir = SITE, prefix = ''): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...publishedPages(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))
      out.push({ file: rel, text: readFileSync(join(dir, entry.name), 'utf8') });
  }
  return out;
}


/**
 * Names matching the tool pattern that are NOT tools, each with why.
 *
 * The same shape as agentpod's `NOT_OUR_ENV_VARS`, and for the same reason: without it, this
 * check fails on documentation that is *correct*, and the obvious way to green it is to delete a
 * true sentence. A test whose failure is fixed by making the docs worse is worse than no test.
 */
const NOT_A_TOOL: Record<string, string> = {
  kaambaan_session:
    "the session cookie's name (docs/02, docs/01), not an MCP tool — it just matches the pattern",
  kaambaan_request_input:
    'named ONLY to say it does not exist: an elicitation is an activity on both wires, and docs/04 ' +
    'and docs/05 say so explicitly. Removing the mention would delete the clarification.',
};

/** The tools actually registered, from the one file that registers them. */
const registeredTools = (): string[] =>
  [...new Set([...read('apps/api/src/mcp/tools.ts').matchAll(/'(kaambaan_[a-z_]+)'/g)].map((m) => m[1]!))].sort();

describe('the MCP tools the docs name', () => {
  const registered = registeredTools;

  
const named = (): string[] =>
    [
      ...new Set(
        [...allDocs(), ...publishedPages()].flatMap(({ text }) =>
          [...text.matchAll(/\bkaambaan_[a-z_]+\b/g)].map((m) => m[0]),
        ),
      ),
    ].sort();

  it('finds tools at all — a guard on the guard', () => {
    // An empty scan passes both assertions below for free, and a regex is exactly the thing that
    // quietly stops matching when somebody reformats the file it reads.
    expect(registered().length).toBeGreaterThan(5);
    expect(registered()).toContain('kaambaan_claim_card');
    expect(named().length).toBeGreaterThan(5);
  });

  it('are all tools that exist', () => {
    // A documented tool that does not exist is worse than an undocumented one: an agent reads the
    // docs, calls the name it was given, and gets an error about a tool the docs invented.
    const ghosts = named().filter((n) => !registered().includes(n) && !(n in NOT_A_TOOL));
    expect(ghosts, 'named in a doc, registered nowhere').toEqual([]);
  });

  it('cover every tool that exists', () => {
    const undocumented = registered().filter((n) => !named().includes(n));
    expect(undocumented, 'registered, named in no doc').toEqual([]);
  });
});

describe('the exemptions', () => {
  it('every one records why it is not a tool', () => {
    // An exemption with no reason is an exemption nobody can re-examine.
    for (const [name, reason] of Object.entries(NOT_A_TOOL)) {
      expect(reason.length, `${name} must record why`).toBeGreaterThan(30);
    }
  });

  it('and none of them is actually a registered tool', () => {
    // If one ever becomes real, the exemption must go rather than hide it.
    for (const name of Object.keys(NOT_A_TOOL)) {
      expect(registeredTools(), `${name} is registered — drop the exemption`).not.toContain(name);
    }
  });
});

describe('internal links in the docs', () => {
  const links = () =>
    allDocs().flatMap(({ file, text }) =>
      [...text.matchAll(/\]\((\.\/[^)\s]+)\)/g)].map((m) => ({ from: file, target: m[1]! })),
    );

  it('the scan actually reads links', () => {
    expect(links().length).toBeGreaterThan(5);
  });

  it('all resolve — both the file and the #anchor', () => {
    const broken: string[] = [];
    for (const { from, target } of links()) {
      const [rel, anchor] = target.replace(/^\.\//, '').split('#');
      if (!rel) continue;
      // Resolved against the filesystem, not a list of top-level markdown files: docs link into
      // `wireframes/` and `superpowers/specs/`, and an earlier version of this check reported
      // both as broken when both exist.
      const abs = join(DOCS, rel);
      if (!existsSync(abs)) {
        broken.push(`${from} → ${target} (no such file)`);
        continue;
      }
      if (!anchor || !rel.endsWith('.md')) continue;
      const slugs = readFileSync(abs, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('#'))
        .map((l) =>
          l.replace(/^#+\s*/, '').toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'),
        );
      if (!slugs.includes(anchor)) broken.push(`${from} → ${target} (no such heading)`);
    }
    expect(broken).toEqual([]);
  });
});

describe('the published site', () => {
  it('has pages at all — a guard on the guard', () => {
    expect(publishedPages().length).toBeGreaterThan(5);
  });

  it('no published page links to the agentpod.dev apex', () => {
    // Eight pages linked to the apex until a crawl of the live site caught it. At the time
    // it served nothing over HTTPS, so a reader clicking "AgentPod" got a connection
    // failure — not even a 404.
    //
    // That is no longer true: agentpod.dev moved to Cloudflare on 2026-09-12 and now serves
    // the product's landing page. The guard stays, on the weaker but still good ground that
    // a reader following a product name from inside documentation wants that product's
    // DOCUMENTATION, not its marketing page. If someone decides the marketing page is the
    // better destination, delete this test rather than work around it — the original reason
    // has expired and only the editorial one remains.
    //
    // Checked statically, on the host, rather than by fetching: a test that makes network
    // calls fails on a train, and a flaky test in CI teaches people to re-run rather than
    // to look.
    const offenders = publishedPages().flatMap(({ file, text }) =>
      [...text.matchAll(/https:\/\/agentpod\.dev(?![a-z0-9.-])/g)].map(() => file)
    );
    expect(offenders, 'link to https://docs.agentpod.dev instead').toEqual([]);
  });

  it('every internal link resolves to a page that exists', () => {
    // Starlight routes by slug, so `/use/gates/` is `use/gates.md`. A link to a page nobody wrote
    // renders as a 404 for a stranger, which is the audience least able to recover from one.
    const slugs = new Set(publishedPages().map((p) => p.file.replace(/\.mdx?$/, '')));
    const broken: string[] = [];
    for (const { file, text } of publishedPages()) {
      for (const m of text.matchAll(/\]\(\/([a-z0-9/-]*)\/?\)/g)) {
        const slug = m[1]!.replace(/\/$/, '');
        if (slug === '') continue; // the site root
        if (!slugs.has(slug) && !slugs.has(`${slug}/index`)) broken.push(`${file} → /${slug}/`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every page declares a title and a description', () => {
    // The description is the search result and the social card. A page published without one is
    // published without the line that decides whether anybody opens it.
    const missing = publishedPages()
      .filter(({ text }) => !/^title:/m.test(text) || !/^description:/m.test(text))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });
});

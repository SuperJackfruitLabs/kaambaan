/**
 * The generated reference pages, held to the code they are generated from.
 *
 * The CLI's pages are generated and guarded in `packages/cli` (`reference.test.ts`), beside the
 * command table. What lives here is what that package cannot see: the MCP server's registrations,
 * and the API's own scope rules, both in `apps/api` — whose test pool has no `node:fs`.
 *
 * To regenerate the MCP page after changing a tool: `pnpm -F @superpipeline/docs-check reference`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_PAGE, recordTools, renderMcpReference } from './mcp-reference';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTENT = join(REPO, 'docs-site/src/content/docs');

describe('the MCP tool reference', () => {
  it('is generated from every registered tool, and committed as generated', async () => {
    const tools = await recordTools(REPO);
    // A guard on the guard: a recorder that captured nothing renders a page that matches nothing.
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.map((t) => t.name)).toContain('superpipeline_claim_card');
    const page = renderMcpReference(tools);
    for (const t of tools) expect(page).toContain(`## ${t.name}`);

    const path = join(CONTENT, MCP_PAGE);
    if (process.env.UPDATE_REFERENCE === '1') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, page);
    }
    expect(existsSync(path), `${MCP_PAGE} is missing — run pnpm -F @superpipeline/docs-check reference`).toBe(true);
    expect(readFileSync(path, 'utf8'), `${MCP_PAGE} is stale — run pnpm -F @superpipeline/docs-check reference`).toBe(page);
  });
});

interface Spec {
  path: string[];
  routes: Array<{ method: string; path: string }>;
  access: { role: string | null; agent: string | null };
}

describe("the CLI reference's agent-scope claims", () => {
  /**
   * The board router's own rule for which scope a board route needs (`auth/scopes.ts`). Each claim
   * the command table makes about a board route is checked against it, so moving a route to another
   * scope on the server fails here instead of leaving the reference wrong.
   */
  it('agree with requiredScope for every board route', async () => {
    const { COMMANDS } = (await import(join(REPO, 'packages/cli/src/commands.ts'))) as { COMMANDS: Spec[] };
    const { requiredScope, SCOPE_FORBIDDEN } = (await import(join(REPO, 'apps/api/src/auth/scopes.ts'))) as {
      requiredScope: (rest: string, method: string, opts?: { hasBoardId?: boolean }) => string | null;
      SCOPE_FORBIDDEN: string;
    };
    let checked = 0;
    const wrong: string[] = [];
    for (const c of COMMANDS) {
      const route = c.routes[0];
      const m = route?.path.match(/^\/v1\/boards(?:\/:boardId(?:\/(.*))?)?$/);
      if (!route || !m) continue;
      const hasBoardId = route.path !== '/v1/boards';
      const rest = (m[1] ?? '').replace(/:[A-Za-z]+/g, 'x');
      const verdict = requiredScope(rest, route.method, { hasBoardId });
      const claim = c.access.agent;
      // `refused` on a route requiredScope leaves open is a route the board router never sends an
      // agent to at all (`isAgentRoute`), which this cannot see — only a scope claim is checkable.
      if (claim === 'refused' && verdict !== SCOPE_FORBIDDEN) continue;
      checked++;
      const expected = claim === 'refused' ? SCOPE_FORBIDDEN : claim === 'any' ? null : claim;
      if (verdict !== expected) wrong.push(`supi ${c.path.join(' ')}: table says ${claim}, ${route.method} ${route.path} needs ${verdict}`);
    }
    expect(checked, 'checked no board routes — a guard on the guard').toBeGreaterThan(10);
    expect(wrong).toEqual([]);
  });
});

function publishedPages(dir = CONTENT, prefix = ''): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...publishedPages(join(dir, entry.name), rel));
    else if (/\.mdx?$/.test(entry.name)) out.push({ file: rel, text: readFileSync(join(dir, entry.name), 'utf8') });
  }
  return out;
}

describe('the published pages', () => {
  it('name no host or agent from one particular deployment', () => {
    // The product word is "workspace". A page that says which machine or which agent did
    // something describes one operator's estate, not the product a stranger installs.
    const LOCAL = /\b(guild|ashram|foundry|chotu)\b/i;
    const offenders = publishedPages().flatMap(({ file, text }) =>
      text.split('\n').filter((l) => LOCAL.test(l)).map((l) => `${file}: ${l.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('put the reference in the sidebar and link it from the guide', () => {
    const config = readFileSync(join(REPO, 'docs-site/astro.config.mjs'), 'utf8');
    expect(config).toMatch(/directory:\s*'reference\/cli'/);
    expect(config).toContain("slug: 'reference/mcp-tools'");
    expect(readFileSync(join(CONTENT, 'use/cli.md'), 'utf8')).toContain('](/reference/cli/)');
    expect(readFileSync(join(CONTENT, 'build/mcp.md'), 'utf8')).toContain('](/reference/mcp-tools/)');
  });

  it('describe signing in as the product does it now, not as it did before 2026-10-07', () => {
    // The organization-plane cutover moved every person's sign-in to the shared accounts service.
    // These are the sentences that were still on the site afterwards, each telling a reader to do
    // something that no longer works.
    const STALE = [/uses \*\*GitHub\*\* and nothing else/, /\*\*GitHub, and nothing else\.\*\*/, /fleet login\s+# once, for both planes/, /the fleet token — what superpipeline actually accepts/];
    const offenders = publishedPages().flatMap(({ file, text }) => STALE.filter((re) => re.test(text)).map((re) => `${file}: ${re}`));
    expect(offenders).toEqual([]);
  });
});

/**
 * The claim path reads a stage's `requires`, not just its `owner`.
 *
 * Issue #88 reported the opposite — "`requires` is stored and nothing reads it" — and quoted
 * `board-do.ts`'s own comment as evidence:
 *
 *   Routing is `agent.capabilities.includes(stage.owner)` — exact equality
 *
 * That comment described the product before `stageCapabilitiesMet` shipped on 2026-09-03, and it
 * sat beside `normalizeStageRouting`, which is precisely where somebody asking "how does routing
 * work" would read. A stale comment in the right place is more convincing than the code, and it
 * produced a bug report against behaviour that already worked.
 *
 * So the behaviour is pinned HERE, at the claim boundary, where the report said it failed. The
 * contract's own tests already cover `stageCapabilitiesMet` in isolation; nothing proved a real
 * agent could claim a real card through the route.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const TENANT = 'tnt_requires_claim';
const headers = { 'X-Tenant-Id': TENANT, 'Content-Type': 'application/json' };

/** The Press board's `verify` stage, as an operator actually wrote it. */
const PIPELINE = [
  {
    key: 'verify',
    name: 'Verify claims',
    order: 0,
    ownerKind: 'capability',
    owner: 'claim-check',
    requires: { any: ['claim-check', 'analysis'] },
  },
];

async function cardOnAVerifyBoard(): Promise<string> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'RQ')`)
    .bind(TENANT, `slug-${TENANT}`)
    .run();
  const b = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Requires', stages: PIPELINE }),
  });
  const { boardId } = (await b.json()) as { boardId: string };
  await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Check the claims', ownerUserId: 'usr_a' }),
  });
  return boardId;
}

async function claimAs(boardId: string, agentId: string, capabilities: string[]) {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
    method: 'POST',
    headers: { ...headers, 'X-Agent-Id': agentId },
    body: JSON.stringify({ capabilities }),
  });
  return (await res.json()) as { claimed?: boolean };
}

describe('claiming a stage that names a requirement', () => {
  it('lets an agent holding only the OTHER arm claim it', async () => {
    // The whole of #88. `analysis` is not the owner, and the requirement says it is enough.
    const boardId = await cardOnAVerifyBoard();
    expect(await claimAs(boardId, 'agt_analysis_only', ['analysis'])).toMatchObject({ claimed: true });
  });

  it('still lets the owner claim it', async () => {
    const boardId = await cardOnAVerifyBoard();
    expect(await claimAs(boardId, 'agt_checker', ['claim-check'])).toMatchObject({ claimed: true });
  });

  it('refuses an agent holding neither arm, owner or not', async () => {
    const boardId = await cardOnAVerifyBoard();
    const res = await claimAs(boardId, 'agt_writer', ['writing']);
    expect(res.claimed ?? false).toBe(false);
  });
});

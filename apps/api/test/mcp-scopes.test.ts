/**
 * The MCP surface enforces a token's scopes, as the REST surface does.
 *
 * `requiredScope`/`scopePermits` were consulted at `index.ts:913`, inside the REST board-route
 * branch. `/mcp` is handled at line 203 and never reached it, so a token minted with `['run']`
 * could call `superpipeline_claim_card` over MCP while the identical token was refused
 * `POST /claims` over REST.
 *
 * This is the same defect REST already repaired, and its comment applies unchanged:
 *
 *   A recorded permission nobody checks reads as protection that does not exist.
 *
 * It matters now because giving an agent direct MCP access depends on issuing it a token scoped
 * to `run` and NOT `claim` — the thing that stops a harness holding a lease while asking for more
 * work. Over MCP, that guarantee did not hold.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { createAgent, createAgentToken } from '../src/db/catalog';

const base = 'https://api.test';
const PROTO = '2025-06-18';
const TENANT = 'tnt_mcp_scope';

let runOnly = '';
let claimOnly = '';

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'S')`)
    .bind(TENANT, `slug-${TENANT}`)
    .run();
  const agent = await createAgent(env.DB, TENANT, { name: 'scoped', capabilities: ['research'] });
  runOnly = (await createAgentToken(env.DB, TENANT, agent.id, ['run'])).token;
  claimOnly = (await createAgentToken(env.DB, TENANT, agent.id, ['claim'])).token;
});

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
});

async function toolNames(token: string): Promise<string[]> {
  await SELF.fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
  });
  const res = await SELF.fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
  return (body.result?.tools ?? []).map((t) => t.name);
}

describe('a token scoped to `run` and not `claim`', () => {
  it('is not offered the tool it may not call', async () => {
    // Not "registered and refused inside the handler" — the hub's own MCP states the rule this
    // follows: an agent is not offered a tool it must not call, because a check inside a handler
    // is a check one handler out of nine can be written without.
    const names = await toolNames(runOnly);
    expect(names).not.toContain('superpipeline_claim_card');
  });

  it('keeps every tool its scope does permit', async () => {
    const names = await toolNames(runOnly);
    for (const t of ['superpipeline_complete', 'superpipeline_block', 'superpipeline_fail', 'superpipeline_release', 'superpipeline_heartbeat']) {
      expect(names, `run scope must keep ${t}`).toContain(t);
    }
  });

  it('keeps the reads, which name nobody and carry no authority', async () => {
    const names = await toolNames(runOnly);
    expect(names).toContain('superpipeline_get_card');
    expect(names).toContain('superpipeline_list_work');
  });
});

describe('a token scoped to `claim` alone', () => {
  it('may claim', async () => {
    expect(await toolNames(claimOnly)).toContain('superpipeline_claim_card');
  });

  it('KEEPS the run verbs, because `claim` grandfathers `run` on purpose', async () => {
    // Asserted rather than assumed, because the obvious expectation is the opposite one and it is
    // wrong. `auth/scopes.ts` records why: every token minted before that file existed holds
    // `['claim']` alone, and enforcing the split literally would let those agents take a card and
    // then be refused every verb that finishes it — taken and abandoned mid-flight, which is
    // strictly worse for the board than the unchecked scope was. "A claim an agent cannot
    // complete is not a safer claim."
    //
    // The direction this change is actually for is the other one, above: `run` must not grant
    // `claim`, so a run-scoped agent cannot hold a lease and ask for more work.
    const names = await toolNames(claimOnly);
    for (const t of ['superpipeline_complete', 'superpipeline_block', 'superpipeline_fail']) {
      expect(names, `the grandfather clause must keep ${t}`).toContain(t);
    }
  });
});

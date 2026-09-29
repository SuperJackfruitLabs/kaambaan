import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

/**
 * A token may be minted with a narrower scope than the default.
 *
 * Both call sites passed `AGENT_TOKEN_SCOPES` — `['claim','run']` — so there was no way to issue a
 * credential that can finish the card it holds and cannot ask for another. That narrowing is the
 * whole basis for giving an agent direct MCP access: AgentPod's prompt contract objects that a
 * harness driving the board itself "would keep a lease open past the card it was claimed for", and
 * a run-only token is the answer to it.
 */
describe('POST /v1/agents/:id/tokens — scopes', () => {
  const T = { 'X-Tenant-Id': 'tnt_scoped_mint', 'X-User-Id': 'usr_o', 'Content-Type': 'application/json' };

  async function agentId(): Promise<string> {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'SM')`)
      .bind('tnt_scoped_mint', 'slug-tnt-scoped-mint').run();
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES ('usr_o', 'o@test')`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO memberships (id, tenant_id, user_id, role) VALUES ('mbr_sm', 'tnt_scoped_mint', 'usr_o', 'owner')`).run();
    const res = await SELF.fetch('https://api.test/v1/agents', {
      method: 'POST', headers: T, body: JSON.stringify({ name: 'scoped', capabilities: ['code'] }),
    });
    return ((await res.json()) as { agent: { id: string } }).agent.id;
  }

  const mint = (id: string, body: unknown) =>
    SELF.fetch(`https://api.test/v1/agents/${id}/tokens`, { method: 'POST', headers: T, body: JSON.stringify(body) });

  const scopesOf = async (tokenId: string) =>
    JSON.parse(((await env.DB.prepare(`SELECT scopes_json AS s FROM agent_tokens WHERE id = ?`).bind(tokenId).first<{ s: string }>())!).s);

  it('mints both scopes when the caller asks for nothing, as it always did', async () => {
    const id = await agentId();
    const res = await mint(id, {});
    expect(res.status).toBe(201);
    const { tokenId } = (await res.json()) as { tokenId: string };
    expect(await scopesOf(tokenId)).toEqual(['claim', 'run']);
  });

  it('mints a run-only token when asked', async () => {
    const id = await agentId();
    const res = await mint(id, { scopes: ['run'] });
    expect(res.status).toBe(201);
    const { tokenId } = (await res.json()) as { tokenId: string };
    expect(await scopesOf(tokenId)).toEqual(['run']);
  });

  it('refuses a scope that does not exist, rather than storing a permission nothing reads', async () => {
    const id = await agentId();
    expect((await mint(id, { scopes: ['admin'] })).status).toBe(400);
    expect((await mint(id, { scopes: [] })).status).toBe(400);
    expect((await mint(id, { scopes: 'run' })).status).toBe(400);
  });
});

import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';

/**
 * What `/mcp`'s OAuth surface actually is (docs/05 §2).
 *
 * The docs used to promise "OAuth 2.1 … PKCE flow → audience-validated bearer", and an external
 * team planned an integration against that sentence. None of it existed. These tests pin the
 * honest shape so the claim cannot drift back: a Resource Server *shell* over a bearer token, whose
 * discovery chain dead-ends because the authorization server it advertises is not served.
 *
 * These assertions are deliberately inverted — they pass because a thing is ABSENT. If someone
 * implements a real authorization server, this file fails, which is the point: the doc that
 * describes the absence has to be rewritten in the same commit.
 */

beforeAll(setupCatalog);

const base = 'https://api.test';

/** Parse a response as JSON, or null if it isn't JSON (a 404, or the SPA's index.html). */
async function jsonOrNull(res: Response): Promise<Record<string, unknown> | null> {
  if (!res.ok) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe('/mcp OAuth surface — a Resource Server shell, and nothing behind it', () => {
  it('advertises an authorization server that it does not serve (the dead end)', async () => {
    const meta = await jsonOrNull(await SELF.fetch(`${base}/.well-known/oauth-protected-resource`));
    expect(meta, 'protected-resource metadata must be served').not.toBeNull();

    // It names this very origin as the authorization server...
    expect(meta!.authorization_servers).toEqual([base]);

    // ...and this origin serves no authorization-server metadata. A spec-compliant MCP client that
    // follows the 401 → metadata → AS discovery chain fails right here.
    const asMeta = await jsonOrNull(await SELF.fetch(`${base}/.well-known/oauth-authorization-server`));
    expect(asMeta?.authorization_endpoint ?? null).toBeNull();
    expect(asMeta?.token_endpoint ?? null).toBeNull();
    expect(asMeta?.registration_endpoint ?? null).toBeNull();
  });

  it('serves no authorization, token, or client-registration endpoint', async () => {
    for (const path of ['/authorize', '/oauth/authorize', '/token', '/oauth/token', '/register']) {
      const doc = await jsonOrNull(await SELF.fetch(`${base}${path}`));
      expect(doc?.access_token ?? null, `${path} must not issue tokens`).toBeNull();
      expect(doc?.authorization_endpoint ?? null, `${path} must not be an AS`).toBeNull();
    }
  });

  it('names no audience anywhere in its metadata — nothing mints or validates an `aud`', async () => {
    const meta = (await jsonOrNull(await SELF.fetch(`${base}/.well-known/oauth-protected-resource`)))!;
    expect(Object.keys(meta)).toEqual(
      expect.arrayContaining(['resource', 'authorization_servers', 'bearer_methods_supported', 'resource_name']),
    );
    expect(JSON.stringify(meta)).not.toMatch(/"aud"|audience/i);
  });

  it('takes the same `kbn_` token as the REST surface — that is the real credential', async () => {
    const tenantId = 'tnt_oauth';
    const agent = await createAgent(env.DB, tenantId, { name: 'MCP client', capabilities: ['research'] });
    const { token } = await createAgentToken(env.DB, tenantId, agent.id, ['claim']);

    const res = await SELF.fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status, 'a kbn_ token authenticates /mcp').toBe(200);

    // And a token that was never minted does not.
    const bad = await SELF.fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer kbn_0000000000000000000000000000000000000000000000',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(bad.status).toBe(401);
  });
});

describe('agent discovery — the AgentCard docs 04 §2 promised', () => {
  it('serves no /.well-known/agent-card.json', async () => {
    const card = await jsonOrNull(await SELF.fetch(`${base}/.well-known/agent-card.json`));
    // An A2A AgentCard is identified by these; none of them can appear, because nothing serves one.
    expect(card?.protocolVersion ?? null).toBeNull();
    expect(card?.skills ?? null).toBeNull();
    expect(card?.capabilities ?? null).toBeNull();
  });
});

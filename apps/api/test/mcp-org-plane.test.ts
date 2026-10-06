import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair } from 'jose';
import { setupCatalog } from './helpers/catalog';
import { withOrgPlane, planeToken, ORG, OTHER_ORG, AGENT, PLANE, MCP_AUD, APP_AUD } from './helpers/org-plane';
import { createAgent, createAgentToken, setAgentExternalMapping } from '../src/db/catalog';
import { ensureOrgTenant } from '../src/auth/org-tenancy';

beforeAll(setupCatalog);

/**
 * The MCP surface end to end against a locally generated Ed25519 plane: discovery, challenge,
 * and a JSON-RPC call — the path a real client (Claude Code) walks, minus the browser consent.
 */
const rpc = (token: string | null, method = 'tools/list') =>
  SELF.fetch('https://api.test/mcp', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  });

async function toolNames(res: Response): Promise<string[]> {
  const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((t) => t.name);
}

describe('MCP discovery in plane mode', () => {
  it('challenges with resource_metadata naming the /mcp metadata document', async () => {
    await withOrgPlane(async () => {
      const res = await rpc(null);
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(
        'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp"',
      );
    });
  });

  it('serves RFC 9728 metadata for /mcp that points at the plane', async () => {
    await withOrgPlane(async () => {
      const meta = (await (await SELF.fetch('https://api.test/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
      expect(meta.resource).toBe(MCP_AUD);
      expect(meta.authorization_servers).toEqual([PLANE]);
      expect(JSON.stringify(meta)).not.toContain('/api/auth');
      expect(meta.bearer_methods_supported).toEqual(['header']);
    });
  });

  it('describes the app itself at the root metadata path', async () => {
    await withOrgPlane(async () => {
      const meta = (await (await SELF.fetch('https://api.test/.well-known/oauth-protected-resource')).json()) as Record<string, unknown>;
      expect(meta.resource).toBe(APP_AUD);
      expect(meta.authorization_servers).toEqual([PLANE]);
    });
  });

  it('leaves discovery exactly as it was when plane mode is off', async () => {
    const meta = (await (await SELF.fetch('https://api.test/.well-known/oauth-protected-resource')).json()) as Record<string, unknown>;
    expect(meta.authorization_servers).toEqual(['https://api.test']);
    expect((await rpc(null)).headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource"',
    );
  });
});

describe('MCP calls in plane mode', () => {
  it('an agent token for the MCP audience works, with the claim verb offered', async () => {
    await withOrgPlane(async () => {
      const tenantId = await ensureOrgTenant(env.DB, ORG);
      const agent = await createAgent(env.DB, tenantId, { name: 'Builder', capabilities: ['build'] });
      await setAgentExternalMapping(env.DB, tenantId, agent.id, { externalSource: 'org-plane', externalId: AGENT });
      const res = await rpc(await planeToken({ sub: AGENT, principalKind: 'agent' }, { aud: [MCP_AUD, `${PLANE}/api/auth/oauth2/userinfo`] }));
      expect(res.status).toBe(200);
      expect(await toolNames(res)).toContain('superpipeline_claim_card');
    });
  });

  it('a human token works and is offered reads only', async () => {
    await withOrgPlane(async () => {
      const res = await rpc(await planeToken({}, { aud: MCP_AUD }));
      expect(res.status).toBe(200);
      const names = await toolNames(res);
      expect(names).toContain('superpipeline_list_work');
      expect(names).not.toContain('superpipeline_claim_card');
    });
  });

  it('refuses a token for the app audience at /mcp', async () => {
    await withOrgPlane(async () => {
      expect((await rpc(await planeToken({}, { aud: APP_AUD }))).status).toBe(401);
    });
  });

  it('answers product_not_enabled for an org without superpipeline', async () => {
    await withOrgPlane(async () => {
      const res = await rpc(await planeToken({ org: OTHER_ORG, ent: [] }, { aud: MCP_AUD }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'product_not_enabled', org: OTHER_ORG });
    });
  });

  it('refuses a forged token and a service token', async () => {
    await withOrgPlane(async () => {
      const stranger = (await generateKeyPair('EdDSA')).privateKey;
      expect((await rpc(await planeToken({}, { aud: MCP_AUD, kid: 'x', key: stranger }))).status).toBe(401);
      expect((await rpc(await planeToken({ principalKind: 'service' }, { aud: MCP_AUD }))).status).toBe(401);
    });
  });

  it('still accepts a spa_ token in plane mode', async () => {
    await withOrgPlane(async () => {
      const agent = await createAgent(env.DB, 'tnt_mcp_spa', { name: 'Spa', capabilities: ['x'] });
      const { token } = await createAgentToken(env.DB, 'tnt_mcp_spa', agent.id, ['claim']);
      expect((await rpc(token)).status).toBe(200);
    });
  });

  it('fails closed when ORG_PLANE_ISSUER is set but the rest is missing — not even the dev bearer', async () => {
    const bag = env as unknown as Record<string, unknown>;
    expect((await rpc('tnt_mcp_half:agt_half:x')).status, 'control: dev bearer works with plane mode off').toBe(200);
    bag.ORG_PLANE_ISSUER = PLANE;
    try {
      expect((await rpc('tnt_mcp_half:agt_half:x')).status).toBe(401);
    } finally {
      delete bag.ORG_PLANE_ISSUER;
    }
  });
});

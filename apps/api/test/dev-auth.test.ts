import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { resolveUser, resolveAgent } from '../src/auth/resolve';
import { resolveMcpAuth } from '../src/mcp/auth';
import wranglerConfig from '../wrangler.jsonc?raw';

// Dev-mode auth (X-Tenant-Id / X-Agent-Id headers, ?tenant=, the `<tenant>:<agent>:<caps>` MCP
// bearer) is opt-IN: it only exists when DEV_AUTH is explicitly "true". A deploy that forgets to
// pass the flag must therefore be safe by default — an `X-Tenant-Id` header is not a credential.
// Local dev opts in via `wrangler dev --var DEV_AUTH:true`; the tests via vitest.config.ts.

/** The default environment: no DEV_AUTH set at all (a bare `wrangler deploy`). */
const defaultEnv = { ...env, DEV_AUTH: undefined } as unknown as Env;
/** Explicitly opted in (local dev + tests). */
const optedIn = { ...env, DEV_AUTH: 'true' } as unknown as Env;

function devRequest(url = 'https://api.test/v1/boards'): Request {
  return new Request(url, { headers: { 'X-Tenant-Id': 'tnt_victim', 'X-Agent-Id': 'agt_x', 'X-User-Id': 'usr_admin' } });
}

describe('dev auth is opt-in (safe by default)', () => {
  it('refuses dev headers as a user credential when the flag is absent', async () => {
    expect(await resolveUser(devRequest(), defaultEnv)).toBeNull();
    expect(await resolveUser(devRequest(), optedIn)).toMatchObject({ tenantId: 'tnt_victim', userId: 'usr_admin' });
  });

  it('refuses the ?tenant= websocket fallback when the flag is absent', async () => {
    const ws = new Request('https://api.test/v1/boards/brd_1/ws?tenant=tnt_victim');
    expect(await resolveUser(ws, defaultEnv)).toBeNull();
    expect(await resolveUser(ws, optedIn)).toMatchObject({ tenantId: 'tnt_victim' });
  });

  it('refuses dev headers as an agent credential when the flag is absent', async () => {
    expect(await resolveAgent(devRequest(), defaultEnv)).toBeNull();
    expect(await resolveAgent(devRequest(), optedIn)).toMatchObject({ tenantId: 'tnt_victim', agentId: 'agt_x' });
  });

  it('refuses the dev MCP bearer when the flag is absent', async () => {
    const mcp = new Request('https://api.test/mcp', { headers: { Authorization: 'Bearer tnt_victim:agt_x:research' } });
    expect(await resolveMcpAuth(mcp, defaultEnv)).toBeNull();
    expect(await resolveMcpAuth(mcp, optedIn)).toMatchObject({ tenantId: 'tnt_victim', agentId: 'agt_x' });
  });

  it('only "true" opts in — any other value is off', async () => {
    for (const value of ['false', '1', 'TRUE', '']) {
      expect(await resolveUser(devRequest(), { ...env, DEV_AUTH: value } as unknown as Env)).toBeNull();
    }
  });

  it('401s a dev-header request end-to-end on a default deploy', async () => {
    const res = await worker.fetch(devRequest(), defaultEnv);
    expect(res.status).toBe(401);
  });

  it('is not enabled by the deployed wrangler config', () => {
    // The regression this guards: `vars: { DEV_AUTH: "true" }` in wrangler.jsonc made every
    // `wrangler deploy` that forgot `--var DEV_AUTH:false` ship an app where any X-Tenant-Id header
    // is a full credential for that tenant. The flag belongs in the dev command, not the config.
    const withoutComments = wranglerConfig
      .split('\n')
      .filter((line: string) => !line.trim().startsWith('//'))
      .join('\n');
    const parsed = JSON.parse(withoutComments) as { vars?: Record<string, string> };
    expect(parsed.vars?.DEV_AUTH).not.toBe('true');
  });

  it('401s a dev-header agent claim end-to-end on a default deploy', async () => {
    const claim = new Request('https://api.test/v1/boards/brd_1/claims', {
      method: 'POST',
      headers: { 'X-Tenant-Id': 'tnt_victim', 'X-Agent-Id': 'agt_x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: ['research'] }),
    });
    const res = await worker.fetch(claim, defaultEnv);
    expect(res.status).toBe(401);
  });
});

import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { createAgentToken } from '../src/db/catalog';

/**
 * The write side of `agent_tokens.revoked_at` (charter decisions/2026-08-13-ecosystem-identity.md
 * Decision 3): `findAgentByTokenHash` already filters `WHERE at.revoked_at IS NULL` on every
 * agent request (catalog.ts). Only the write was missing — this is that write, plus the route
 * that reaches it.
 *
 * Revocation is a HUMAN act, exactly like minting: the route accepts the same session/dev-header
 * auth `POST /v1/agents` and `DELETE /v1/agents/:id` already use, and nothing else — an agent
 * bearing a `kbn_` token must not be able to revoke its own, or a peer's, to escape an audit.
 */
const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

const RESEARCH_PIPELINE = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'done', name: 'Done', order: 1, ownerKind: 'human' },
];

async function createBoard(tenant: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: dev(tenant),
    body: JSON.stringify({ name: 'B', stages: RESEARCH_PIPELINE }),
  });
  return (await res.json<{ boardId: string }>()).boardId;
}

function claim(boardId: string, token: string) {
  return SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

describe('revoking an agent token', () => {
  it('makes the very next request carrying it fail', async () => {
    const created = await (
      await SELF.fetch('https://api.test/v1/agents', {
        method: 'POST',
        headers: dev('tnt_revoke_1'),
        body: JSON.stringify({ name: 'Research bot', capabilities: ['research'] }),
      })
    ).json<{ agent: { id: string }; token: string; tokenId: string }>();

    const boardId = await createBoard('tnt_revoke_1');
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev('tnt_revoke_1'),
      body: JSON.stringify({ title: 'Investigate' }),
    });

    // The token works before revocation.
    const before = await claim(boardId, created.token);
    expect((await before.json<{ claimed: boolean }>()).claimed).toBe(true);

    const revoke = await SELF.fetch(`https://api.test/v1/agents/${created.agent.id}/tokens/${created.tokenId}`, {
      method: 'DELETE',
      headers: dev('tnt_revoke_1'),
    });
    expect(revoke.status).toBe(204);

    // The very next request carrying the same token is refused.
    const after = await claim(boardId, created.token);
    expect(after.status).toBe(401);
  });

  it('leaves another token for the same agent working — revocation is per credential, not per agent', async () => {
    const created = await (
      await SELF.fetch('https://api.test/v1/agents', {
        method: 'POST',
        headers: dev('tnt_revoke_2'),
        body: JSON.stringify({ name: 'Research bot', capabilities: ['research'] }),
      })
    ).json<{ agent: { id: string }; token: string; tokenId: string }>();

    // A second credential for the SAME agent — there is no HTTP route to mint an extra token for
    // an existing agent yet, so this goes straight at the catalog, exactly as
    // test/agent-external-mapping.test.ts does for its own setup.
    const second = await createAgentToken(env.DB, 'tnt_revoke_2', created.agent.id, ['claim']);

    const boardId = await createBoard('tnt_revoke_2');
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev('tnt_revoke_2'),
      body: JSON.stringify({ title: 'Investigate' }),
    });

    const revoke = await SELF.fetch(`https://api.test/v1/agents/${created.agent.id}/tokens/${created.tokenId}`, {
      method: 'DELETE',
      headers: dev('tnt_revoke_2'),
    });
    expect(revoke.status).toBe(204);

    const firstAfter = await claim(boardId, created.token);
    expect(firstAfter.status).toBe(401);

    const secondStill = await claim(boardId, second.token);
    expect((await secondStill.json<{ claimed: boolean }>()).claimed).toBe(true);
  });

  it('is not an error to revoke twice', async () => {
    const created = await (
      await SELF.fetch('https://api.test/v1/agents', {
        method: 'POST',
        headers: dev('tnt_revoke_3'),
        body: JSON.stringify({ name: 'Bot' }),
      })
    ).json<{ agent: { id: string }; tokenId: string }>();

    const first = await SELF.fetch(`https://api.test/v1/agents/${created.agent.id}/tokens/${created.tokenId}`, {
      method: 'DELETE',
      headers: dev('tnt_revoke_3'),
    });
    expect(first.status).toBe(204);

    const second = await SELF.fetch(`https://api.test/v1/agents/${created.agent.id}/tokens/${created.tokenId}`, {
      method: 'DELETE',
      headers: dev('tnt_revoke_3'),
    });
    expect(second.status).toBe(204);
  });

  it('does not leak whether a nonexistent token id existed', async () => {
    const created = await (
      await SELF.fetch('https://api.test/v1/agents', {
        method: 'POST',
        headers: dev('tnt_revoke_4'),
        body: JSON.stringify({ name: 'Bot' }),
      })
    ).json<{ agent: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/agents/${created.agent.id}/tokens/tok_doesnotexist00000000`, {
      method: 'DELETE',
      headers: dev('tnt_revoke_4'),
    });
    expect(res.status).toBe(204);
  });

  it('is a human act — an agent token, or no credential at all, cannot revoke', async () => {
    const created = await (
      await SELF.fetch('https://api.test/v1/agents', {
        method: 'POST',
        headers: dev('tnt_revoke_5'),
        body: JSON.stringify({ name: 'Bot' }),
      })
    ).json<{ agent: { id: string }; token: string; tokenId: string }>();

    const noAuth = await SELF.fetch(`https://api.test/v1/agents/${created.agent.id}/tokens/${created.tokenId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(noAuth.status).toBe(401);

    // The agent's own bearer token is not a human credential and must not authorise revocation.
    const viaAgentToken = await SELF.fetch(`https://api.test/v1/agents/${created.agent.id}/tokens/${created.tokenId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' },
    });
    expect(viaAgentToken.status).toBe(401);
  });
});

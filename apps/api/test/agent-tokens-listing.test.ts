/**
 * The UI's revoke path (slice C, task 4): `revokeAgentToken` and its route shipped in slice B
 * with no way for the console to know a token's id — `GET /v1/agents` never surfaced one, so the
 * only way to reach the route was to already have the plaintext-mint response in hand, which the
 * console throws away. This proves the id the agent list now returns is exactly the id the revoke
 * route accepts, and that revoking it (the console's whole path — list, then revoke by the listed
 * id) fails the very next request carrying that token.
 *
 * Also proves the empty state: an agent with nothing active is a real, nameable state, not an
 * absence the console has to infer.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { createAgent, listAgents } from '../src/db/catalog';

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

describe('the agent list carries what the console needs to revoke a token', () => {
  it('lists the active token id, and revoking BY THAT ID fails the very next request', async () => {
    const created = await (
      await SELF.fetch('https://api.test/v1/agents', {
        method: 'POST',
        headers: dev('tnt_toklist_1'),
        body: JSON.stringify({ name: 'Research bot', capabilities: ['research'] }),
      })
    ).json<{ agent: { id: string }; token: string }>();

    // The console's actual path: it does NOT hold onto the plaintext-mint response (that modal is
    // long closed by the time someone opens "agents" again) — it re-lists, and the listing is the
    // only source of a token id to revoke.
    const listed = await (await SELF.fetch('https://api.test/v1/agents', { headers: dev('tnt_toklist_1') })).json<{
      agents: Array<{ id: string; tokenIds: string[] }>;
    }>();
    const row = listed.agents.find((a) => a.id === created.agent.id);
    expect(row?.tokenIds.length).toBe(1);
    const tokenId = row!.tokenIds[0]!;

    const boardId = await createBoard('tnt_toklist_1');
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev('tnt_toklist_1'),
      body: JSON.stringify({ title: 'Investigate' }),
    });

    const before = await claim(boardId, created.token);
    expect((await before.json<{ claimed: boolean }>()).claimed).toBe(true);

    const revoke = await SELF.fetch(`https://api.test/v1/agents/${created.agent.id}/tokens/${tokenId}`, {
      method: 'DELETE',
      headers: dev('tnt_toklist_1'),
    });
    expect(revoke.status).toBe(204);

    const after = await claim(boardId, created.token);
    expect(after.status).toBe(401);

    // The listing now shows nothing active for this agent — the empty state the console renders.
    const listedAfter = await (await SELF.fetch('https://api.test/v1/agents', { headers: dev('tnt_toklist_1') })).json<{
      agents: Array<{ id: string; tokenIds: string[] }>;
    }>();
    expect(listedAfter.agents.find((a) => a.id === created.agent.id)?.tokenIds).toEqual([]);
  });

  it('a freshly created agent with no minted token lists an empty tokenIds — not undefined, not an error', async () => {
    // `createAgent` (catalog) mints no token by itself — only the REST route mints one
    // immediately after create — so this is the direct way to see the zero-token case.
    await createAgent(env.DB, 'tnt_toklist_2', { name: 'Bot' });
    const listed = await listAgents(env.DB, 'tnt_toklist_2');
    expect(listed[0]!.tokenIds).toEqual([]);
  });
});

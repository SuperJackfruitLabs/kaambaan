import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Setting what an agent may queue, through the product rather than through SQL.
 *
 * Migration 0015 shipped three columns and the route that reads them, and NOTHING that could write
 * them — so the feature could not be configured at all without opening a database. That is the
 * field-with-no-consumer failure this estate keeps hitting, in the direction that matters most: a
 * permission whose only setter is a human with a SQL prompt is a permission nobody can audit.
 *
 * They hang off `PATCH /v1/agents/:id`, which already exists, is already admin-scoped, and is
 * already where an operator changes what an agent is.
 */
const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });
const TENANT = 'tnt_qrest';

async function agent(name: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/agents', {
    method: 'POST',
    headers: dev(TENANT),
    body: JSON.stringify({ name, capabilities: ['command'] }),
  });
  return (await res.json<{ agent: { id: string } }>()).agent.id;
}

async function patch(agentId: string, body: unknown) {
  const res = await SELF.fetch(`https://api.test/v1/agents/${agentId}`, {
    method: 'PATCH',
    headers: dev(TENANT),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json<Record<string, never>>() };
}

async function readAgent(agentId: string) {
  const res = await SELF.fetch('https://api.test/v1/agents', { headers: dev(TENANT) });
  const { agents } = await res.json<{ agents: Array<Record<string, unknown>> }>();
  return agents.find((a) => a.id === agentId)!;
}

const PIPELINE = [{ key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' }];

/** Two real boards, because the allowlist is checked against this workspace's boards. */
let boardA: string;
let boardB: string;

async function board(name: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: dev(TENANT),
    body: JSON.stringify({ name, stages: PIPELINE }),
  });
  return (await res.json<{ boardId: string }>()).boardId;
}

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, name) VALUES ('usr_qr','qr@example.test','QR')`).run();
  boardA = await board('Alpha');
  boardB = await board('Beta');
});

describe('PATCH /v1/agents/:id — the queueing policy', () => {
  it('a new agent reads back as permitted to queue nothing', async () => {
    const id = await agent('Fresh coordinator');
    const a = await readAgent(id);
    expect(a.ownerUserId).toBeNull();
    expect(a.mayQueueTo).toBeNull();
    expect(a.queueCeilingPerHour).toBe(20);
  });

  it('sets all three, and GET reports them so the operator can verify', async () => {
    // Readable as well as writable. A permission you can set and cannot see is one nobody audits.
    const id = await agent('Coordinator');
    const res = await patch(id, {
      ownerUserId: 'usr_qr',
      mayQueueTo: [boardA, boardB],
      queueCeilingPerHour: 6,
    });
    expect(res.status).toBe(200);
    const a = await readAgent(id);
    expect(a.ownerUserId).toBe('usr_qr');
    expect(a.mayQueueTo).toEqual([boardA, boardB]);
    expect(a.queueCeilingPerHour).toBe(6);
  });

  it('clears the allowlist back to NONE with null, which is not the same as []', async () => {
    const id = await agent('Revocable');
    await patch(id, { mayQueueTo: [boardA] });
    await patch(id, { mayQueueTo: null });
    expect((await readAgent(id)).mayQueueTo).toBeNull();
    await patch(id, { mayQueueTo: [] });
    expect((await readAgent(id)).mayQueueTo).toEqual([]);
  });

  it('refuses an owner who is not a user in this workspace', async () => {
    // The whole point of the column is that a real human is answerable for the card. A typo'd id
    // would own work to somebody who does not exist — which is the `usr_dev` failure with extra
    // steps, and it would only surface when an agent tried to queue.
    const id = await agent('Mistyped');
    const res = await patch(id, { ownerUserId: 'usr_nobody' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/not a user/i);
  });

  it('refuses a board id that is not a board in this workspace', async () => {
    // Same reasoning one step along: an allowlist naming a board that does not exist permits
    // nothing, silently, and reads as configured.
    const id = await agent('Wrong board');
    const res = await patch(id, { mayQueueTo: ['brd_does_not_exist'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/board/i);
  });

  it('refuses a ceiling that is not a whole number of at least one', async () => {
    // Zero would be a coordinator that holds the scope and silently cannot use it. If the operator
    // means that, the allowlist is where they say so.
    const id = await agent('Bad ceiling');
    for (const queueCeilingPerHour of [0, -1, 2.5, 'lots']) {
      expect((await patch(id, { queueCeilingPerHour })).status).toBe(400);
    }
  });

  it('still refuses a patch that names nothing, and now names these fields when it does', async () => {
    const id = await agent('Empty patch');
    const res = await patch(id, {});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/mayQueueTo/);
  });
});

/**
 * An unexpected failure on the `/v1/agents` routes is a structured 500, not an escape.
 *
 * Ruling 9, parked from an earlier fix round and closed here. The only catch-all in `index.ts`
 * wrapped `/v1/boards` alone, so anything unforeseen in the agents block — a raced UNIQUE write
 * against `agents_external_pair_unique`, a malformed body, a D1 hiccup — left the Worker's
 * `fetch` handler entirely instead of becoming a response a client could read. Same write
 * safety, strictly worse failure.
 *
 * Malformed JSON is the deterministic way to reach that path: `await request.json()` throws, from
 * inside the route block, exactly where a raced constraint error would. The point is the SHAPE of
 * what comes back, not the particular trigger.
 */
import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

describe('/v1/agents answers unexpected errors in the shape the rest of the API uses', () => {
  it('a malformed body on POST /v1/agents becomes a 500 with { error: { message } }', async () => {
    const res = await SELF.fetch('https://api.test/v1/agents', {
      method: 'POST',
      headers: dev('tnt_are_post'),
      body: 'not json at all',
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { message: string } }>();
    expect(typeof body.error.message, 'a readable message, not an empty object').toBe('string');
  });

  it('and so does one on PATCH /v1/agents/:id, past the tenant guard', async () => {
    const created = await SELF.fetch('https://api.test/v1/agents', {
      method: 'POST',
      headers: dev('tnt_are_patch'),
      body: JSON.stringify({ name: 'Patchable', capabilities: [] }),
    });
    const agentId = (await created.json<{ agent: { id: string } }>()).agent.id;

    const res = await SELF.fetch(`https://api.test/v1/agents/${agentId}`, {
      method: 'PATCH',
      headers: dev('tnt_are_patch'),
      body: '{ "externalId": ',
    });
    expect(res.status).toBe(500);
    expect(typeof (await res.json<{ error: { message: string } }>()).error.message).toBe('string');
  });

  it('the same shape the boards routes have always answered with', async () => {
    const boards = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: dev('tnt_are_boards'),
      body: 'also not json',
    });
    expect(boards.status).toBe(500);
    expect(await boards.json()).toHaveProperty('error.message');
  });
});

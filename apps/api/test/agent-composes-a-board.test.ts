import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { createAgent, createAgentToken, updateAgent } from '../src/db/catalog';

/**
 * An agent composes a board.
 *
 * The previous spec put "editing stages" on the human-only side with a sound argument — "changing a
 * stage re-routes every card on it and can strand work" — and then applied it to board CREATION too,
 * where it does not hold: a new board has NO CARDS, so bad routing there strands nothing.
 *
 * What this must not do is let that reasoning leak back: an agent may make a board, and may write a
 * stage's prose, and may never change routing on a board that already holds work.
 */
const PIPELINE = [
  { key: 'doing', name: 'Doing', order: 0, ownerKind: 'capability', owner: 'code' },
  { key: 'done', name: 'Done', order: 1, ownerKind: 'human' },
];
const TENANT = 'tnt_compose';
const dev = () => ({ 'X-Tenant-Id': TENANT, 'Content-Type': 'application/json' });
const auth = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const BASE = 'https://api.test';

let composer = '';
let composerId = '';
let planner = '';
let worker = '';
let existingBoard = '';

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'Compose')`)
    .bind(TENANT, `slug-${TENANT}`)
    .run();
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, name) VALUES ('usr_comp','c@example.test','C')`).run();

  const k = await createAgent(env.DB, TENANT, { name: 'keeper-karen', capabilities: ['documentation'] });
  composerId = k.id;
  composer = (await createAgentToken(env.DB, TENANT, k.id, ['read', 'compose'])).token;
  await updateAgent(env.DB, TENANT, k.id, { ownerUserId: 'usr_comp' });

  const p = await createAgent(env.DB, TENANT, { name: 'planner', capabilities: ['planning'] });
  planner = (await createAgentToken(env.DB, TENANT, p.id, ['read', 'plan'])).token;
  await updateAgent(env.DB, TENANT, p.id, { ownerUserId: 'usr_comp' });

  const w = await createAgent(env.DB, TENANT, { name: 'worker', capabilities: ['code'] });
  worker = (await createAgentToken(env.DB, TENANT, w.id, ['claim', 'run'])).token;

  const res = await SELF.fetch(`${BASE}/v1/boards`, {
    method: 'POST',
    headers: dev(),
    body: JSON.stringify({ name: 'Made by a person', stages: PIPELINE }),
  });
  existingBoard = (await res.json<{ boardId: string }>()).boardId;
});

async function compose(token: string, name: string) {
  const res = await SELF.fetch(`${BASE}/v1/boards`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name, stages: PIPELINE }),
  });
  return { status: res.status, body: await res.json<Record<string, never>>() };
}

describe('creating a board', () => {
  it('a `compose` token makes one, and the board RECORDS who made it', () => {
    // The provenance half. `boards` recorded no creator at all, so without this an agent-made board
    // would be indistinguishable from the operator's.
    return (async () => {
      const made = await compose(composer, 'Made by an agent');
      expect(made.status).toBe(201);
      const boardId = (made.body as unknown as { boardId: string }).boardId;
      const row = await env.DB.prepare(
        `SELECT created_by AS createdBy, created_by_agent_id AS agentId FROM boards WHERE id = ?`,
      )
        .bind(boardId)
        .first<{ createdBy: string | null; agentId: string | null }>();
      expect(row?.agentId).toBe(composerId);
      // Owned by the human the operator named for that agent — never a literal, never nobody.
      expect(row?.createdBy).toBe('usr_comp');
    })();
  });

  it('a board a PERSON made records no agent, rather than a fabricated one', async () => {
    const row = await env.DB.prepare(`SELECT created_by_agent_id AS agentId FROM boards WHERE id = ?`)
      .bind(existingBoard)
      .first<{ agentId: string | null }>();
    expect(row?.agentId).toBeNull();
  });

  it('refuses a `plan` token — composing is not rearranging', async () => {
    const res = await compose(planner, 'Not mine to make');
    expect(res.status).toBe(403);
  });

  it('refuses a worker token, the grandfather regression once more', async () => {
    const res = await compose(worker, 'Definitely not');
    expect(res.status).toBe(403);
  });

  it('refuses an agent with no owner, by name', async () => {
    // A board nobody is answerable for is not a board — the same rule, and the same code, as queueing.
    const a = await createAgent(env.DB, TENANT, { name: 'ownerless', capabilities: ['documentation'] });
    const t = (await createAgentToken(env.DB, TENANT, a.id, ['compose'])).token;
    const res = await compose(t, 'Orphan board');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('AGENT_HAS_NO_OWNER');
  });

  it('stops at the DAILY ceiling, counted per agent', async () => {
    const a = await createAgent(env.DB, TENANT, { name: 'eager-composer', capabilities: ['documentation'] });
    const t = (await createAgentToken(env.DB, TENANT, a.id, ['compose'])).token;
    await updateAgent(env.DB, TENANT, a.id, { ownerUserId: 'usr_comp', boardCeilingPerDay: 2 });
    expect((await compose(t, 'One')).status).toBe(201);
    expect((await compose(t, 'Two')).status).toBe(201);
    const third = await compose(t, 'Three');
    expect(third.status).toBe(429);
    expect(JSON.stringify(third.body)).toContain('BOARD_CEILING_REACHED');
    // And the ceiling is this agent's, not the workspace's: the composer above is unaffected.
    expect((await compose(composer, 'Still fine')).status).toBe(201);
  });
});

describe('writing a stage runbook', () => {
  it('sets `instructions` on an existing board', async () => {
    const res = await SELF.fetch(`${BASE}/v1/boards/${existingBoard}/stages/doing`, {
      method: 'PATCH',
      headers: auth(composer),
      body: JSON.stringify({ instructions: 'Open a pull request before you complete.' }),
    });
    expect(res.status).toBe(200);
    const board = await (await SELF.fetch(`${BASE}/v1/boards/${existingBoard}`, { headers: dev() })).json<{
      stages: Array<{ key: string; instructions?: string }>;
    }>();
    expect(board.stages.find((s) => s.key === 'doing')?.instructions).toContain('pull request');
  });

  it('REFUSES a routing field in the same body, naming it', async () => {
    // The field-level gate. A scope that permitted the whole body would hand an agent `owner` and
    // `requires` through a door opened for prose.
    const res = await SELF.fetch(`${BASE}/v1/boards/${existingBoard}/stages/doing`, {
      method: 'PATCH',
      headers: auth(composer),
      body: JSON.stringify({ instructions: 'fine', owner: 'documentation' }),
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('owner');
  });

  it('REFUSES replacing the pipeline, which is the part that strands cards', async () => {
    const res = await SELF.fetch(`${BASE}/v1/boards/${existingBoard}/stages`, {
      method: 'POST',
      headers: auth(composer),
      body: JSON.stringify({ stages: PIPELINE }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('REFUSES deleting the board — the operator\'s line', async () => {
    const res = await SELF.fetch(`${BASE}/v1/boards/${existingBoard}`, { method: 'DELETE', headers: auth(composer) });
    expect([401, 403]).toContain(res.status);
  });
});

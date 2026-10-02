import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { createAgent, createAgentToken, updateAgent } from '../src/db/catalog';

/**
 * What a coordinator may plan, end to end, through the real routes.
 *
 * The scope table is unit-tested next door (`agent-board-scopes`); this is about the routes actually
 * admitting the credential, because the defect being fixed was never a scope decision — it was that
 * `resolveAgent` is called in ONE place in the Worker, so an agent credential never arrived at
 * `/v1/projects` at all.
 */
const PIPELINE = [
  { key: 'doing', name: 'Doing', order: 0, ownerKind: 'capability', owner: 'code' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'done', name: 'Done', order: 2, ownerKind: 'human' },
];
const TENANT = 'tnt_coord_plan';
const dev = () => ({ 'X-Tenant-Id': TENANT, 'Content-Type': 'application/json' });
const auth = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const BASE = 'https://api.test';

let boardId: string;
let planner: string;
let reader: string;
let worker: string;

beforeAll(async () => {
  // `projects` keeps its `REFERENCES tenants(id)` FK (migration 0013 is run as-is by the test
  // helper), so a dev-header tenant with no row would fail every insert with a 500.
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'Coordination')`)
    .bind(TENANT, `slug-${TENANT}`)
    .run();
  const res = await SELF.fetch(`${BASE}/v1/boards`, {
    method: 'POST',
    headers: dev(),
    body: JSON.stringify({ name: 'Coordination', stages: PIPELINE }),
  });
  boardId = (await res.json<{ boardId: string }>()).boardId;

  const a = await createAgent(env.DB, TENANT, { name: 'Planner', capabilities: ['command'] });
  planner = (await createAgentToken(env.DB, TENANT, a.id, ['read', 'plan'])).token;
  await updateAgent(env.DB, TENANT, a.id, { mayQueueTo: [boardId] });

  const r = await createAgent(env.DB, TENANT, { name: 'Reader', capabilities: ['command'] });
  reader = (await createAgentToken(env.DB, TENANT, r.id, ['read'])).token;

  const w = await createAgent(env.DB, TENANT, { name: 'Worker', capabilities: ['code'] });
  worker = (await createAgentToken(env.DB, TENANT, w.id, ['claim', 'run'])).token;
});

async function card(title: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: dev(),
    body: JSON.stringify({ title }),
  });
  return (await res.json<{ card: { id: string } }>()).card.id;
}

describe('a `plan` token manages the planning layer', () => {
  it('creates a project and a milestone inside it', async () => {
    const made = await SELF.fetch(`${BASE}/v1/projects`, {
      method: 'POST',
      headers: auth(planner),
      body: JSON.stringify({ name: 'Q4 push' }),
    });
    expect(made.status).toBe(201);
    const { project } = await made.json<{ project: { id: string } }>();

    const ms = await SELF.fetch(`${BASE}/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: auth(planner),
      body: JSON.stringify({ name: 'First cut' }),
    });
    expect(ms.status).toBe(201);
  });

  it('edits a card — the thing that keeps work inside a rollup', async () => {
    // A coordinator that can queue a card but not set its project produces work that falls out of
    // every rollup: `cardsTotal` and `costUsd` silently under-count.
    const made = await SELF.fetch(`${BASE}/v1/projects`, {
      method: 'POST',
      headers: auth(planner),
      body: JSON.stringify({ name: 'Rollup home' }),
    });
    const { project } = await made.json<{ project: { id: string } }>();
    const cardId = await card('Needs a project');

    const patched = await SELF.fetch(`${BASE}/v1/boards/${boardId}/cards/${cardId}`, {
      method: 'PATCH',
      headers: auth(planner),
      body: JSON.stringify({ priority: 5, projectId: project.id }),
    });
    expect(patched.status).toBe(200);
    const after = await SELF.fetch(`${BASE}/v1/boards/${boardId}/cards/${cardId}`, { headers: auth(planner) });
    const body = await after.json<{ card: { priority: number; projectId: string | null } }>();
    expect(body.card.priority).toBe(5);
    expect(body.card.projectId).toBe(project.id);
  });

  it('reads the registries a routing diagnosis needs', async () => {
    // No `/cards` here: there is no card-list route in this product. A coordinator reads cards from
    // the board snapshot, which `read` already fetches.
    for (const path of ['/v1/projects', '/v1/labels', '/v1/capabilities', '/v1/agents', `/v1/boards/${boardId}`]) {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: auth(reader) });
      expect(res.status, `${path} must be readable`).toBe(200);
    }
  });
});

describe('what a coordinator still cannot do', () => {
  it('a `read` token cannot create a project', async () => {
    const res = await SELF.fetch(`${BASE}/v1/projects`, {
      method: 'POST',
      headers: auth(reader),
      body: JSON.stringify({ name: 'Not mine to make' }),
    });
    expect(res.status).toBe(403);
  });

  it('a `plan` token cannot QUEUE a card — planning is not spending time', async () => {
    const res = await SELF.fetch(`${BASE}/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: auth(planner),
      body: JSON.stringify({ title: 'Work I was not granted' }),
    });
    expect(res.status).toBe(403);
  });

  it('NO agent token resolves a gate, on any scope — the human half of the control pair', async () => {
    const cardId = await card('Awaiting review');
    for (const token of [planner, reader, worker]) {
      const res = await SELF.fetch(`${BASE}/v1/boards/${boardId}/gates/gate_anything/resolve`, {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ decision: 'approved' }),
      });
      /**
       * 401, and the code says which layer refused.
       *
       * `…/gates/:id/resolve` is not admitted to the agent branch at all — `isEitherRoute` matches
       * `gates/:id` but not its `resolve` subroute — so the request falls to the human branch, which
       * finds no person behind an agent token. 401 means "this door does not take that kind of
       * credential"; 403 would mean "admissible, wrong scope". `requiredScope`'s `__forbidden__` for
       * this path is the second line behind the door, and it is what catches the mistake if somebody
       * later widens the door by path.
       *
       * Never a 404: a 404 would mean it got as far as looking the gate up.
       */
      expect(res.status, 'gate resolution must stay human-only').toBe(401);
    }
    expect(cardId).toBeTruthy();
  });

  it('cannot delete a card, a project, or the board', async () => {
    const cardId = await card('Undeletable');
    const made = await SELF.fetch(`${BASE}/v1/projects`, {
      method: 'POST',
      headers: auth(planner),
      body: JSON.stringify({ name: 'Undeletable project' }),
    });
    const { project } = await made.json<{ project: { id: string } }>();

    // A card and the board are not admitted to the agent branch for DELETE, so they 401 at the door;
    // a project IS admitted (the route takes an agent) and is refused on the scope, which is 403.
    // Both are refusals; the difference is only which layer said no.
    for (const [path, expected, label] of [
      [`/v1/boards/${boardId}/cards/${cardId}`, 401, 'a card'],
      [`/v1/boards/${boardId}`, 401, 'the board'],
      [`/v1/projects/${project.id}`, 403, 'a project'],
    ] as const) {
      const res = await SELF.fetch(`${BASE}${path}`, { method: 'DELETE', headers: auth(planner) });
      expect(res.status, `${label} must not be deletable by an agent`).toBe(expected);
    }
  });

  it('cannot restructure the board', async () => {
    const res = await SELF.fetch(`${BASE}/v1/boards/${boardId}/stages`, {
      method: 'POST',
      headers: auth(planner),
      body: JSON.stringify({ stages: PIPELINE }),
    });
    // Not an agent route, so the door refuses before any scope is consulted.
    expect(res.status).toBe(401);
  });

  it('cannot mint a token or manage members', async () => {
    const mint = await SELF.fetch(`${BASE}/v1/agents/agt_anything/tokens`, {
      method: 'POST',
      headers: auth(planner),
      body: JSON.stringify({}),
    });
    expect([401, 403]).toContain(mint.status);
    const members = await SELF.fetch(`${BASE}/v1/members`, { headers: auth(planner) });
    expect([401, 403]).toContain(members.status);
  });

  it('a WORKER token gains none of it — the grandfather regression, once more', async () => {
    for (const path of ['/v1/projects', '/v1/labels', '/v1/capabilities']) {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: auth(worker) });
      expect(res.status, `${path} must refuse a claim/run token`).toBe(403);
    }
  });
});

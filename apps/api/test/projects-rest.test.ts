import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { BoardInit } from '../src/board/board-do';

/**
 * `/v1/projects[/:id[/milestones]]` and `/v1/milestones/:id` — the routing and validation layer
 * over `src/db/projects.ts`, which the module-level tests (`test/projects.test.ts`) never exercise
 * because they call the DB module directly.
 */

const dev = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' });

/**
 * `projects` (migration 0013) carries `REFERENCES tenants(id)`, the same as `labels` — the FK is
 * kept because the real migration file is run as-is (see `test/helpers/catalog.ts`). A route that
 * writes into `projects` through a dev-header tenant with no `tenants` row fails on that FK, so
 * any test that creates a project inserts one first.
 */
async function insertTenant(id: string, slug: string): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, ?)`).bind(id, slug, slug).run();
}

async function createProject(tenant: string, body: Record<string, unknown>) {
  return SELF.fetch('https://api.test/v1/projects', { method: 'POST', headers: dev(tenant), body: JSON.stringify(body) });
}

const PIPE: BoardInit['stages'] = [{ key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' }];

async function board(tenant: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: dev(tenant),
    body: JSON.stringify({ name: 'Projects', stages: PIPE }),
  });
  return (await res.json<{ boardId: string }>()).boardId;
}

async function card(tenant: string, boardId: string, title: string): Promise<string> {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: dev(tenant),
    body: JSON.stringify({ title }),
  });
  return (await res.json<{ card: { id: string } }>()).card.id;
}

async function readCard(tenant: string, boardId: string, cardId: string): Promise<{ projectId: string | null; milestoneId: string | null }> {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${cardId}`, { headers: dev(tenant) });
  return (await res.json<{ card: { projectId: string | null; milestoneId: string | null } }>()).card;
}

describe('GET /v1/projects', () => {
  it('lists only this tenant\'s projects', async () => {
    const t = 'tnt_prj_rest_list';
    await insertTenant(t, 'prj-rest-list');
    await createProject(t, { name: 'alpha' });

    const res = await SELF.fetch('https://api.test/v1/projects', { headers: dev(t) });
    expect(res.status).toBe(200);
    const { projects } = await res.json<{ projects: { name: string }[] }>();
    expect(projects.some((p) => p.name === 'alpha')).toBe(true);
  });
});

describe('POST /v1/projects', () => {
  it('creates a project, defaulting state to active', async () => {
    const t = 'tnt_prj_rest_create';
    await insertTenant(t, 'prj-rest-create');

    const res = await createProject(t, { name: 'supermd v1', description: 'the thing', leadUserId: 'usr_x' });
    expect(res.status).toBe(201);
    const { project } = await res.json<{ project: { name: string; state: string; health: string | null } }>();
    expect(project.name).toBe('supermd v1');
    expect(project.state).toBe('active');
    expect(project.health).toBeNull();
  });

  it('400s a missing name', async () => {
    const t = 'tnt_prj_rest_noname';
    await insertTenant(t, 'prj-rest-noname');
    const res = await createProject(t, { description: 'no name here' });
    expect(res.status).toBe(400);
  });

  it('refuses a duplicate name as a 409 sentence, not a raw constraint failure', async () => {
    const t = 'tnt_prj_rest_dupe';
    await insertTenant(t, 'prj-rest-dupe');
    const first = await createProject(t, { name: 'dupe-me' });
    expect(first.status).toBe(201);

    const again = await createProject(t, { name: 'dupe-me' });
    expect(again.status).toBe(409);
    expect((await again.json<{ error: string }>()).error).toContain('"dupe-me"');
  });

  /**
   * The brief calls this out by name: `targetDate` is validated against Task 5's
   * `^\d{4}-\d{2}-\d{2}$` validator, reused rather than rewritten.
   */
  it('400s a malformed targetDate rather than storing garbage', async () => {
    const t = 'tnt_prj_rest_baddate';
    await insertTenant(t, 'prj-rest-baddate');
    const res = await createProject(t, { name: 'bad date project', targetDate: 'next week' });
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed targetDate', async () => {
    const t = 'tnt_prj_rest_gooddate';
    await insertTenant(t, 'prj-rest-gooddate');
    const res = await createProject(t, { name: 'good date project', targetDate: '2026-12-31' });
    expect(res.status).toBe(201);
    const { project } = await res.json<{ project: { targetDate: string | null } }>();
    expect(project.targetDate).toBe('2026-12-31');
  });
});

describe('GET /v1/projects/:id', () => {
  it('returns the project with its milestones in sortOrder', async () => {
    const t = 'tnt_prj_rest_show';
    await insertTenant(t, 'prj-rest-show');
    const made = await createProject(t, { name: 'with milestones' });
    const { project } = await made.json<{ project: { id: string } }>();

    await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'second', sortOrder: 1 }),
    });
    await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'first', sortOrder: 0 }),
    });

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}`, { headers: dev(t) });
    expect(res.status).toBe(200);
    const body = await res.json<{ project: { id: string }; milestones: { name: string }[] }>();
    expect(body.project.id).toBe(project.id);
    expect(body.milestones.map((m) => m.name)).toEqual(['first', 'second']);
  });

  it('404s an unknown id', async () => {
    const t = 'tnt_prj_rest_unknown';
    await insertTenant(t, 'prj-rest-unknown');
    const res = await SELF.fetch('https://api.test/v1/projects/prj_doesnotexist', { headers: dev(t) });
    expect(res.status).toBe(404);
  });

  /**
   * A 403 here would confirm the row exists under some tenant — the exact oracle that lets a
   * caller enumerate another tenant's project ids one guess at a time. 404 is what both "wrong
   * tenant" and "no such id" must answer, indistinguishably.
   */
  it('answers a cross-tenant read with 404, not 403 — a correct id must not be distinguishable from a wrong one', async () => {
    const owner = 'tnt_prj_rest_owner';
    const stranger = 'tnt_prj_rest_stranger';
    await insertTenant(owner, 'prj-rest-owner');
    await insertTenant(stranger, 'prj-rest-stranger');
    const made = await createProject(owner, { name: 'not yours' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}`, { headers: dev(stranger) });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /v1/projects/:id', () => {
  it('updates name, state and health', async () => {
    const t = 'tnt_prj_rest_patch';
    await insertTenant(t, 'prj-rest-patch');
    const made = await createProject(t, { name: 'to update' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ name: 'updated', state: 'paused', health: 'at-risk' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ project: { name: string; state: string; health: string | null } }>();
    expect(body.project.name).toBe('updated');
    expect(body.project.state).toBe('paused');
    expect(body.project.health).toBe('at-risk');
  });

  it('400s an unknown state rather than storing it', async () => {
    const t = 'tnt_prj_rest_badstate';
    await insertTenant(t, 'prj-rest-badstate');
    const made = await createProject(t, { name: 'bad state target' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ state: 'nearly' }),
    });
    expect(res.status).toBe(400);
  });

  it('400s an unknown health rather than storing it', async () => {
    const t = 'tnt_prj_rest_badhealth';
    await insertTenant(t, 'prj-rest-badhealth');
    const made = await createProject(t, { name: 'bad health target' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ health: 'vibes' }),
    });
    expect(res.status).toBe(400);
  });

  it('400s a malformed targetDate', async () => {
    const t = 'tnt_prj_rest_patchdate';
    await insertTenant(t, 'prj-rest-patchdate');
    const made = await createProject(t, { name: 'patch bad date' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ targetDate: 'soon' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s an unknown id', async () => {
    const t = 'tnt_prj_rest_patchunknown';
    await insertTenant(t, 'prj-rest-patchunknown');
    const res = await SELF.fetch('https://api.test/v1/projects/prj_doesnotexist', {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ name: 'whatever' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/projects/:id', () => {
  it('deletes a project and its milestones cascade', async () => {
    const t = 'tnt_prj_rest_delete';
    await insertTenant(t, 'prj-rest-delete');
    const made = await createProject(t, { name: 'to delete' });
    const { project } = await made.json<{ project: { id: string } }>();
    await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'doomed' }),
    });

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}`, { method: 'DELETE', headers: dev(t) });
    expect(res.status).toBe(204);

    const after = await SELF.fetch(`https://api.test/v1/projects/${project.id}`, { headers: dev(t) });
    expect(after.status).toBe(404);
  });

  it('404s an unknown id', async () => {
    const t = 'tnt_prj_rest_deleteunknown';
    await insertTenant(t, 'prj-rest-deleteunknown');
    const res = await SELF.fetch('https://api.test/v1/projects/prj_doesnotexist', { method: 'DELETE', headers: dev(t) });
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/projects/:id/milestones', () => {
  it('creates a milestone under a project', async () => {
    const t = 'tnt_prj_rest_mscreate';
    await insertTenant(t, 'prj-rest-mscreate');
    const made = await createProject(t, { name: 'for milestones' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'kickoff', targetDate: '2026-11-01' }),
    });
    expect(res.status).toBe(201);
    const { milestone } = await res.json<{ milestone: { name: string; targetDate: string | null; projectId: string } }>();
    expect(milestone.name).toBe('kickoff');
    expect(milestone.targetDate).toBe('2026-11-01');
    expect(milestone.projectId).toBe(project.id);
  });

  it('400s a missing name', async () => {
    const t = 'tnt_prj_rest_msnoname';
    await insertTenant(t, 'prj-rest-msnoname');
    const made = await createProject(t, { name: 'no milestone name' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('400s a malformed targetDate', async () => {
    const t = 'tnt_prj_rest_msbaddate';
    await insertTenant(t, 'prj-rest-msbaddate');
    const made = await createProject(t, { name: 'milestone bad date' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'soon', targetDate: 'whenever' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s when the project belongs to another tenant, rather than attaching across the boundary', async () => {
    const owner = 'tnt_prj_rest_msowner';
    const stranger = 'tnt_prj_rest_msstranger';
    await insertTenant(owner, 'prj-rest-msowner');
    await insertTenant(stranger, 'prj-rest-msstranger');
    const made = await createProject(owner, { name: 'owners project' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(stranger),
      body: JSON.stringify({ name: 'sneaky' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/milestones/:id', () => {
  it('deletes one milestone without deleting its project', async () => {
    const t = 'tnt_prj_rest_msdelete';
    await insertTenant(t, 'prj-rest-msdelete');
    const made = await createProject(t, { name: 'keep me' });
    const { project } = await made.json<{ project: { id: string } }>();
    const msRes = await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'removable' }),
    });
    const { milestone } = await msRes.json<{ milestone: { id: string } }>();

    const del = await SELF.fetch(`https://api.test/v1/milestones/${milestone.id}`, { method: 'DELETE', headers: dev(t) });
    expect(del.status).toBe(204);

    const show = await SELF.fetch(`https://api.test/v1/projects/${project.id}`, { headers: dev(t) });
    expect(show.status).toBe(200);
    const body = await show.json<{ milestones: { id: string }[] }>();
    expect(body.milestones.find((m) => m.id === milestone.id)).toBeUndefined();
  });

  it('404s an unknown id', async () => {
    const t = 'tnt_prj_rest_msdeleteunknown';
    await insertTenant(t, 'prj-rest-msdeleteunknown');
    const res = await SELF.fetch('https://api.test/v1/milestones/mls_doesnotexist', { method: 'DELETE', headers: dev(t) });
    expect(res.status).toBe(404);
  });
});

/**
 * `PATCH /v1/boards/:id/cards/:cardId` — `milestoneId` validation (Task 19, step 2). The DO
 * cannot check that a milestone belongs to the project it is about to be attached under —
 * milestones are in D1 — so the route does, the same shape `labels`' unknown-id check takes in
 * `labels-rest.test.ts`.
 */
describe('PATCH /v1/boards/:id/cards/:cardId — milestoneId validation', () => {
  it('refuses a milestoneId from a different project, naming MILESTONE_NOT_IN_PROJECT', async () => {
    const t = 'tnt_prj_rest_msmismatch';
    await insertTenant(t, 'prj-rest-msmismatch');

    const madeA = await createProject(t, { name: 'project A' });
    const { project: projectA } = await madeA.json<{ project: { id: string } }>();
    const madeB = await createProject(t, { name: 'project B' });
    const { project: projectB } = await madeB.json<{ project: { id: string } }>();

    const msRes = await SELF.fetch(`https://api.test/v1/projects/${projectA.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'A-only milestone' }),
    });
    const { milestone } = await msRes.json<{ milestone: { id: string } }>();

    const b = await board(t);
    const id = await card(t, b, 'Wrong project');

    // The card belongs to project B; the milestone belongs to project A.
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ projectId: projectB.id, milestoneId: milestone.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('MILESTONE_NOT_IN_PROJECT');

    // Refused before the write lands — the card carries neither.
    const after = await readCard(t, b, id);
    expect(after.projectId).toBeNull();
    expect(after.milestoneId).toBeNull();
  });

  it('refuses a milestoneId when the card has no projectId at all, in the same request or already stored', async () => {
    const t = 'tnt_prj_rest_msnoproject';
    await insertTenant(t, 'prj-rest-msnoproject');

    const made = await createProject(t, { name: 'orphaned milestone target' });
    const { project } = await made.json<{ project: { id: string } }>();
    const msRes = await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'needs a project' }),
    });
    const { milestone } = await msRes.json<{ milestone: { id: string } }>();

    const b = await board(t);
    const id = await card(t, b, 'No project');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ milestoneId: milestone.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('MILESTONE_NOT_IN_PROJECT');
  });

  it('accepts a milestoneId that belongs to the projectId set in the SAME request', async () => {
    const t = 'tnt_prj_rest_msmatch';
    await insertTenant(t, 'prj-rest-msmatch');

    const made = await createProject(t, { name: 'matching project' });
    const { project } = await made.json<{ project: { id: string } }>();
    const msRes = await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'on track' }),
    });
    const { milestone } = await msRes.json<{ milestone: { id: string } }>();

    const b = await board(t);
    const id = await card(t, b, 'Matching project');

    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ projectId: project.id, milestoneId: milestone.id }),
    });
    expect(res.status).toBe(200);

    const after = await readCard(t, b, id);
    expect(after.projectId).toBe(project.id);
    expect(after.milestoneId).toBe(milestone.id);
  });

  it('accepts a milestoneId against a projectId already stored on the card from an earlier PATCH', async () => {
    const t = 'tnt_prj_rest_msalreadystored';
    await insertTenant(t, 'prj-rest-msalreadystored');

    const made = await createProject(t, { name: 'already-assigned project' });
    const { project } = await made.json<{ project: { id: string } }>();
    const msRes = await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'later milestone' }),
    });
    const { milestone } = await msRes.json<{ milestone: { id: string } }>();

    const b = await board(t);
    const id = await card(t, b, 'Assigned earlier');

    const first = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(first.status).toBe(200);

    // This PATCH sends ONLY milestoneId — the route must read the card's already-stored
    // projectId to validate against, not assume it is missing because the body omits it.
    const second = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ milestoneId: milestone.id }),
    });
    expect(second.status).toBe(200);

    const after = await readCard(t, b, id);
    expect(after.projectId).toBe(project.id);
    expect(after.milestoneId).toBe(milestone.id);
  });

  it('refuses changing projectId out from under an already-stored milestone, leaving both untouched', async () => {
    const t = 'tnt_prj_rest_msprojectchange';
    await insertTenant(t, 'prj-rest-msprojectchange');

    const madeA = await createProject(t, { name: 'original project' });
    const { project: projectA } = await madeA.json<{ project: { id: string } }>();
    const madeB = await createProject(t, { name: 'new project' });
    const { project: projectB } = await madeB.json<{ project: { id: string } }>();
    const msRes = await SELF.fetch(`https://api.test/v1/projects/${projectA.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'A-only milestone' }),
    });
    const { milestone } = await msRes.json<{ milestone: { id: string } }>();

    const b = await board(t);
    const id = await card(t, b, 'Starts in A');
    const first = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ projectId: projectA.id, milestoneId: milestone.id }),
    });
    expect(first.status).toBe(200);

    // ONLY projectId changes — milestoneId is not in the body at all. The card's already-stored
    // milestone (project A's) would now belong to a card in project B, which the route must catch
    // even though `body.milestoneId` says nothing.
    const second = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ projectId: projectB.id }),
    });
    expect(second.status).toBe(400);
    expect((await second.json<{ error: { code: string } }>()).error.code).toBe('MILESTONE_NOT_IN_PROJECT');

    // Refused before the write lands — the card still carries project A and its milestone.
    const after = await readCard(t, b, id);
    expect(after.projectId).toBe(projectA.id);
    expect(after.milestoneId).toBe(milestone.id);
  });

  it('refuses clearing projectId to null out from under an already-stored milestone', async () => {
    const t = 'tnt_prj_rest_msprojectnull';
    await insertTenant(t, 'prj-rest-msprojectnull');

    const made = await createProject(t, { name: 'project to clear' });
    const { project } = await made.json<{ project: { id: string } }>();
    const msRes = await SELF.fetch(`https://api.test/v1/projects/${project.id}/milestones`, {
      method: 'POST',
      headers: dev(t),
      body: JSON.stringify({ name: 'the milestone' }),
    });
    const { milestone } = await msRes.json<{ milestone: { id: string } }>();

    const b = await board(t);
    const id = await card(t, b, 'Starts assigned');
    const first = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ projectId: project.id, milestoneId: milestone.id }),
    });
    expect(first.status).toBe(200);

    const second = await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ projectId: null }),
    });
    expect(second.status).toBe(400);
    expect((await second.json<{ error: { code: string } }>()).error.code).toBe('MILESTONE_NOT_IN_PROJECT');

    const after = await readCard(t, b, id);
    expect(after.projectId).toBe(project.id);
    expect(after.milestoneId).toBe(milestone.id);
  });
});

/**
 * `GET /v1/projects/:id/rollup` (Task 19) — the one route in this module that fans out to every
 * board's Durable Object (`computeRollup`, `db/projects.ts`) and the one that serves the staleness
 * contract (`partial`/`boardsUnanswered`/`computedAt`) to a caller. Had no test at all until this
 * block: a regression that dropped `partial` from the cached row's mapping would have passed every
 * other test in the suite while serving a confident-looking row the computation itself knew was
 * incomplete.
 */
describe('GET /v1/projects/:id/rollup', () => {
  it('reuses the cached row inside 60s — a cache HIT returns the SAME computedAt, not merely a recent one', async () => {
    const t = 'tnt_prj_rest_rollupcache';
    await insertTenant(t, 'prj-rest-rollupcache');
    const made = await createProject(t, { name: 'cached' });
    const { project } = await made.json<{ project: { id: string } }>();
    const b = await board(t);
    const id = await card(t, b, 'One');
    await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ projectId: project.id }),
    });

    const first = await SELF.fetch(`https://api.test/v1/projects/${project.id}/rollup`, { headers: dev(t) });
    expect(first.status).toBe(200);
    const { rollup: r1 } = await first.json<{ rollup: { computedAt: string; cardsTotal: number } }>();
    expect(r1.cardsTotal).toBe(1);

    const second = await SELF.fetch(`https://api.test/v1/projects/${project.id}/rollup`, { headers: dev(t) });
    const { rollup: r2 } = await second.json<{ rollup: { computedAt: string } }>();
    // Not "close to r1.computedAt" — the SAME value. A second request that recomputed anyway would
    // still read as "recent" but would not be serving the cache the 60s window exists to provide.
    expect(r2.computedAt).toBe(r1.computedAt);
  });

  it('recomputes to a strictly newer computedAt once the cached row is older than 60s', async () => {
    const t = 'tnt_prj_rest_rollupstale';
    await insertTenant(t, 'prj-rest-rollupstale');
    const made = await createProject(t, { name: 'stale' });
    const { project } = await made.json<{ project: { id: string } }>();
    const b = await board(t);
    const id = await card(t, b, 'One');
    await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ projectId: project.id }),
    });

    const first = await SELF.fetch(`https://api.test/v1/projects/${project.id}/rollup`, { headers: dev(t) });
    const { rollup: r1 } = await first.json<{ rollup: { computedAt: string } }>();

    // Backdated directly in D1 rather than waiting 61 real seconds.
    const backdated = new Date(Date.now() - 61_000).toISOString();
    await env.DB.prepare(`UPDATE project_rollups SET computed_at = ? WHERE project_id = ?`).bind(backdated, project.id).run();

    const second = await SELF.fetch(`https://api.test/v1/projects/${project.id}/rollup`, { headers: dev(t) });
    const { rollup: r2 } = await second.json<{ rollup: { computedAt: string } }>();
    expect(r2.computedAt).not.toBe(r1.computedAt);
    expect(new Date(r2.computedAt).getTime()).toBeGreaterThan(new Date(backdated).getTime());
  });

  it('partial and boardsUnanswered survive the cache round trip, not just the fresh computation', async () => {
    const t = 'tnt_prj_rest_rolluppartial';
    await insertTenant(t, 'prj-rest-rolluppartial');
    const made = await createProject(t, { name: 'partial' });
    const { project } = await made.json<{ project: { id: string } }>();
    const b = await board(t);
    const id = await card(t, b, 'One');
    await SELF.fetch(`https://api.test/v1/boards/${b}/cards/${id}`, {
      method: 'PATCH',
      headers: dev(t),
      body: JSON.stringify({ projectId: project.id }),
    });
    // A catalog row whose Durable Object was never initialized — `projectSummary` can't answer it.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES ('brd_rollup_ghost', ?, 'ghost', '[]')`,
    )
      .bind(t)
      .run();

    const first = await SELF.fetch(`https://api.test/v1/projects/${project.id}/rollup`, { headers: dev(t) });
    const { rollup: r1 } = await first.json<{ rollup: { partial: boolean; boardsUnanswered: number; computedAt: string } }>();
    expect(r1.partial).toBe(true);
    expect(r1.boardsUnanswered).toBe(1);

    // A SECOND read, inside the 60s window, must come from the cached row rather than a fresh
    // computation — proven the same way as the cache-hit test above, by the identical computedAt —
    // and the partial admission must survive that exact round trip through the row mapping.
    const second = await SELF.fetch(`https://api.test/v1/projects/${project.id}/rollup`, { headers: dev(t) });
    const { rollup: r2 } = await second.json<{ rollup: { partial: boolean; boardsUnanswered: number; computedAt: string } }>();
    expect(r2.computedAt).toBe(r1.computedAt);
    expect(r2.partial).toBe(true);
    expect(r2.boardsUnanswered).toBe(1);
  });

  it('404s a rollup request for another tenant\'s project, rather than a cross-tenant read', async () => {
    const owner = 'tnt_prj_rest_rolluptenant';
    const stranger = 'tnt_prj_rest_rolluptenant_stranger';
    await insertTenant(owner, 'prj-rest-rolluptenant');
    await insertTenant(stranger, 'prj-rest-rolluptenant-stranger');
    const made = await createProject(owner, { name: 'owners rollup' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}/rollup`, { headers: dev(stranger) });
    expect(res.status).toBe(404);
  });

  it('holds the read-role gate: a caller who is not a member of the workspace is refused', async () => {
    const t = 'tnt_prj_rest_rolluprole';
    await insertTenant(t, 'prj-rest-rolluprole');
    // A real membership, so the dev-header fallback (`resolveUser`) stops granting 'owner' to
    // anyone who merely names the tenant — once a workspace has members, the header must name one
    // of them. 'usr_dev' (the default `dev()` identity every other helper in this file relies on)
    // is made a member here so `createProject`/`board`/`card` keep working unmodified.
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES ('usr_dev', 'rolluprole-dev@test.dev')`).run();
    await env.DB.prepare(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('mbr_rolluprole_dev', ?, 'usr_dev', 'owner')`,
    )
      .bind(t)
      .run();
    const made = await createProject(t, { name: 'gated' });
    const { project } = await made.json<{ project: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/projects/${project.id}/rollup`, {
      headers: { 'X-Tenant-Id': t, 'X-User-Id': 'usr_rollup_stranger' },
    });
    expect(res.status).toBe(403);
  });
});

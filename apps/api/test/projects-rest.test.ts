import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

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

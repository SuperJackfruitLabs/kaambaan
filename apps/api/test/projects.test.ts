import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createProject, listProjects, deleteProject, projectById,
  createMilestone, listMilestones,
} from '../src/db/projects';

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_p1', 'p-one', 'One')`),
    env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_p2', 'p-two', 'Two')`),
  ]);
});

describe('projects', () => {
  it('refuses two projects with the same name in one tenant', async () => {
    await createProject(env.DB, 'tnt_p1', { name: 'supermd v1' });
    await expect(createProject(env.DB, 'tnt_p1', { name: 'supermd v1' })).rejects.toThrow();
  });

  it('lets another tenant use the same name, and never shows it across the boundary', async () => {
    await createProject(env.DB, 'tnt_p2', { name: 'supermd v1' });
    const one = await listProjects(env.DB, 'tnt_p1');
    const two = await listProjects(env.DB, 'tnt_p2');
    expect(one.filter((p) => p.name === 'supermd v1')).toHaveLength(1);
    expect(two.filter((p) => p.name === 'supermd v1')).toHaveLength(1);
    expect(one.find((p) => p.name === 'supermd v1')!.id).not.toBe(
      two.find((p) => p.name === 'supermd v1')!.id,
    );
  });

  it('cannot be read from the wrong tenant, even with a correct id', async () => {
    const mine = await createProject(env.DB, 'tnt_p1', { name: 'private plans' });
    expect(await projectById(env.DB, 'tnt_p1', mine.id)).not.toBeNull();
    expect(await projectById(env.DB, 'tnt_p2', mine.id)).toBeNull();
  });

  it('defaults state to active and leaves health unset, because health is a judgement', async () => {
    const p = await createProject(env.DB, 'tnt_p1', { name: 'fresh' });
    expect(p.state).toBe('active');
    expect(p.health).toBeNull();
  });

  it('refuses an unknown state rather than storing it', async () => {
    await expect(
      createProject(env.DB, 'tnt_p1', { name: 'bad state', state: 'nearly' as never }),
    ).rejects.toThrow();
  });
});

describe('milestones', () => {
  it('are deleted with their project, via the cascade', async () => {
    const p = await createProject(env.DB, 'tnt_p1', { name: 'cascade' });
    await createMilestone(env.DB, 'tnt_p1', p.id, { name: 'alpha' });
    expect(await listMilestones(env.DB, 'tnt_p1', p.id)).toHaveLength(1);
    expect(await deleteProject(env.DB, 'tnt_p1', p.id)).toBe(true);
    expect(await listMilestones(env.DB, 'tnt_p1', p.id)).toHaveLength(0);
  });

  it('cannot be attached to a project in another tenant', async () => {
    const theirs = await createProject(env.DB, 'tnt_p2', { name: 'theirs' });
    await expect(createMilestone(env.DB, 'tnt_p1', theirs.id, { name: 'sneaky' })).rejects.toThrow();
  });

  it('order by sortOrder, breaking ties by name so the list is stable between reads', async () => {
    const p = await createProject(env.DB, 'tnt_p1', { name: 'ordered' });
    await createMilestone(env.DB, 'tnt_p1', p.id, { name: 'beta', sortOrder: 1 });
    await createMilestone(env.DB, 'tnt_p1', p.id, { name: 'alpha', sortOrder: 1 });
    await createMilestone(env.DB, 'tnt_p1', p.id, { name: 'zero', sortOrder: 0 });
    expect((await listMilestones(env.DB, 'tnt_p1', p.id)).map((m) => m.name)).toEqual([
      'zero', 'alpha', 'beta',
    ]);
  });
});

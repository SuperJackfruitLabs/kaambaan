import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const BUILD: BoardInit['stages'] = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('BoardDO — agent profiles (docs/05 §7)', () => {
  it('defines and lists profiles (configuration as data)', async () => {
    await runInDurableObject(stubFor('pr-list'), async (board: BoardDO) => {
      await board.init({ id: 'brd_pr', tenantId: 'tnt_a', name: 'PR', stages: BUILD });
      const r = await board.setProfile({ key: 'opus-careful', name: 'Opus (careful)', harness: 'claude-code', model: 'claude-opus-4-8', autonomyLevel: 'suggest', capabilities: ['build'] });
      expect(r.ok).toBe(true);
      const profiles = await board.getProfiles();
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({ key: 'opus-careful', model: 'claude-opus-4-8', autonomyLevel: 'suggest', capabilities: ['build'] });
    });
  });

  it('upserts a profile by key', async () => {
    await runInDurableObject(stubFor('pr-upsert'), async (board: BoardDO) => {
      await board.init({ id: 'brd_pu', tenantId: 'tnt_a', name: 'PU', stages: BUILD });
      await board.setProfile({ key: 'p', model: 'claude-sonnet-4-6' });
      await board.setProfile({ key: 'p', model: 'claude-opus-4-8' });
      const profiles = await board.getProfiles();
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.model).toBe('claude-opus-4-8');
    });
  });

  it('pins the selected profile to the attempt on claim', async () => {
    await runInDurableObject(stubFor('pr-pin'), async (board: BoardDO) => {
      await board.init({ id: 'brd_pp', tenantId: 'tnt_a', name: 'PP', stages: BUILD });
      await board.setProfile({ key: 'opus', model: 'claude-opus-4-8' });
      const c = await board.createCard({ title: 'X', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');
      const claim = await board.claim({ agentId: 'agt_b', capabilities: ['build'], profileKey: 'opus' });
      expect(claim.claimed).toBe(true);
      const attempts = await board.getAttempts(c.value.id);
      expect(attempts[0]!.profileKey).toBe('opus');
    });
  });

  it('round-trips a per-stage routing strategy (pipeline vs manager)', async () => {
    await runInDurableObject(stubFor('pr-routing'), async (board: BoardDO) => {
      await board.init({
        id: 'brd_rt',
        tenantId: 'tnt_a',
        name: 'RT',
        stages: [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build', routing: 'manager' }],
      });
      const snap = await board.getState();
      expect(snap.stages.find((s) => s.key === 'build')?.routing).toBe('manager');
    });
  });
});

/**
 * `POST /v1/boards/:id/profiles` casts its body (`as { key; name?; harness?; ... }`) and used to
 * forward it to `setProfile` WHOLE. Non-leaking today only because `setProfile`'s input type
 * happens to match the route's declared body type exactly. This asserts a key outside that
 * surface is ignored.
 */
describe('REST — POST /v1/boards/:id/profiles: an unexpected body key does not reach the stored profile', () => {
  const dev = { 'X-Tenant-Id': 'tnt_profile_rest_whitelist', 'Content-Type': 'application/json' };

  it('stores the declared fields and ignores a key outside the profile surface', async () => {
    const b = (await (
      await SELF.fetch('https://api.test/v1/boards', { method: 'POST', headers: dev, body: JSON.stringify({ name: 'PR', stages: BUILD }) })
    ).json()) as { boardId: string };

    const res = await SELF.fetch(`https://api.test/v1/boards/${b.boardId}/profiles`, {
      method: 'POST',
      headers: dev,
      body: JSON.stringify({ key: 'sonnet', model: 'claude-sonnet-4-6', notAProfileField: 'should never reach the DO' }),
    });
    expect(res.status).toBe(201);

    const list = (await (await SELF.fetch(`https://api.test/v1/boards/${b.boardId}/profiles`, { headers: dev })).json()) as {
      profiles: Array<Record<string, unknown>>;
    };
    const profile = list.profiles.find((p) => p.key === 'sonnet')!;
    expect(profile.model).toBe('claude-sonnet-4-6');
    expect(profile).not.toHaveProperty('notAProfileField');
  });
});

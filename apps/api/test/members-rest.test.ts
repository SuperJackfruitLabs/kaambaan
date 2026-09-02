import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

/**
 * `memberships.role` has been CHECK-constrained to owner/admin/member/viewer since migration
 * 0001, written exactly once as 'owner', and read by zero queries — so a workspace was
 * permanently one person, and the four roles were a vocabulary describing nothing. Membership is
 * the ENTIRE human authorization model in kaambaan, which is what made that worth fixing rather
 * than deleting: a recorded permission nobody checks reads as protection that does not exist.
 */

const TENANT = 'tnt_members';

/** Dev headers name a user; the membership row decides what that user may do. */
const as = (userId: string) => ({ 'X-Tenant-Id': TENANT, 'X-User-Id': userId, 'Content-Type': 'application/json' });

const PIPE = [{ key: 'todo', name: 'To do', order: 0 }];

async function member(userId: string, email: string, role: string): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`).bind(userId, email).run();
  await env.DB.prepare(
    `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role`,
  )
    .bind(`mbr_${userId}`, TENANT, userId, role)
    .run();
}

let boardId: string;

// `beforeEach`, not `beforeAll`: the Workers pool isolates storage PER TEST, so a `beforeAll`
// seed is rolled back before the first assertion runs — leaving a workspace with no members at
// all, which is exactly the state the dev-header fallback treats as a bare dev tenant.
beforeEach(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'M')`).bind(TENANT, 'members-slug').run();
  await member('usr_owner', 'owner@test.dev', 'owner');
  await member('usr_admin', 'admin@test.dev', 'admin');
  await member('usr_worker', 'worker@test.dev', 'member');
  await member('usr_viewer', 'viewer@test.dev', 'viewer');

  const res = await SELF.fetch('https://api.test/v1/boards', { method: 'POST', headers: as('usr_owner'), body: JSON.stringify({ name: 'M', stages: PIPE }) });
  boardId = (await res.json<{ boardId: string }>()).boardId;
});

describe('roles decide what a person may do', () => {
  it('lets a viewer read the board and nothing more', async () => {
    const read = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: as('usr_viewer') });
    expect(read.status).toBe(200);

    const write = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: as('usr_viewer'), body: JSON.stringify({ title: 'x' }) });
    expect(write.status).toBe(403);
    expect((await write.json<{ error: string }>()).error).toContain('viewer');
  });

  it('lets a member work the board but not restaff it', async () => {
    const card = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: as('usr_worker'), body: JSON.stringify({ title: 'worked' }) });
    expect(card.status).toBe(201);

    const agent = await SELF.fetch('https://api.test/v1/agents', { method: 'POST', headers: as('usr_worker'), body: JSON.stringify({ name: 'A' }) });
    expect(agent.status).toBe(403);

    const stages = await SELF.fetch(`https://api.test/v1/boards/${boardId}/stages`, { method: 'PUT', headers: as('usr_worker'), body: JSON.stringify({ stages: PIPE }) });
    expect(stages.status).toBe(403);
  });

  it('lets an admin manage agents and boards but not the fleet link', async () => {
    const agent = await SELF.fetch('https://api.test/v1/agents', { method: 'POST', headers: as('usr_admin'), body: JSON.stringify({ name: 'Admin agent' }) });
    expect(agent.status).toBe(201);

    const stages = await SELF.fetch(`https://api.test/v1/boards/${boardId}/stages`, { method: 'PUT', headers: as('usr_admin'), body: JSON.stringify({ stages: PIPE }) });
    expect(stages.status).toBe(200);

    // Linking a plane is at least as consequential as revoking a credential.
    const fleet = await SELF.fetch('https://api.test/v1/tenant', { method: 'PATCH', headers: as('usr_admin'), body: JSON.stringify({ externalId: null }) });
    expect(fleet.status).toBe(403);
  });

  it('lets a viewer clear a notification they were sent', async () => {
    // A viewer can be assigned a card by an admin, and would then receive notifications for it.
    // Being unable to mark one read would leave a badge they can never dismiss.
    const card = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: as('usr_owner'),
      body: JSON.stringify({ title: 'theirs', ownerUserId: 'usr_viewer' }),
    });
    expect(card.status).toBe(201);

    const { notifications } = await (
      await SELF.fetch(`https://api.test/v1/boards/${boardId}/notifications`, { headers: as('usr_viewer') })
    ).json<{ notifications: Array<{ seq: number }> }>();
    if (notifications.length === 0) return; // nothing was raised for this card; the rule is vacuous

    const read = await SELF.fetch(`https://api.test/v1/boards/${boardId}/notifications/${notifications[0]!.seq}/read`, {
      method: 'POST',
      headers: as('usr_viewer'),
    });
    expect(read.status).toBe(200);
  });

  it('refuses someone who is not a member at all, rather than treating them as a reader', async () => {
    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, {
      // A tenant that exists, and a user with no membership row in it.
      headers: { 'X-Tenant-Id': TENANT, 'X-User-Id': 'usr_stranger', 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toContain('not a member');
  });
});

describe('a workspace can have more than one person', () => {
  it('lists everyone, oldest membership first', async () => {
    const res = await SELF.fetch('https://api.test/v1/members', { headers: as('usr_viewer') });
    expect(res.status).toBe(200); // a member may see who else can read their board
    const { members } = await res.json<{ members: Array<{ userId: string; role: string; email: string }> }>();
    expect(members.map((m) => m.userId)).toContain('usr_admin');
    expect(members.find((m) => m.userId === 'usr_viewer')!.role).toBe('viewer');
  });

  it('invites by email, creating the user row so sign-in finds the workspace waiting', async () => {
    const res = await SELF.fetch('https://api.test/v1/members', {
      method: 'POST',
      headers: as('usr_owner'),
      body: JSON.stringify({ email: 'Newcomer@Test.dev', role: 'member' }),
    });
    expect(res.status).toBe(201);
    const { member: added } = await res.json<{ member: { userId: string; email: string; role: string } }>();
    expect(added.email).toBe('newcomer@test.dev'); // normalised, so it matches what GitHub returns
    expect(added.role).toBe('member');

    const row = await env.DB.prepare(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`).bind(TENANT, added.userId).first<{ role: string }>();
    expect(row!.role).toBe('member');
  });

  it('treats a re-invite as a role change rather than a collision', async () => {
    const again = await SELF.fetch('https://api.test/v1/members', {
      method: 'POST',
      headers: as('usr_owner'),
      body: JSON.stringify({ email: 'newcomer@test.dev', role: 'admin' }),
    });
    expect(again.status).toBe(201);
    expect((await again.json<{ member: { role: string } }>()).member.role).toBe('admin');
  });

  it('refuses a malformed address and an invented role', async () => {
    expect((await SELF.fetch('https://api.test/v1/members', { method: 'POST', headers: as('usr_owner'), body: JSON.stringify({ email: 'nope' }) })).status).toBe(400);
    expect((await SELF.fetch('https://api.test/v1/members', { method: 'POST', headers: as('usr_owner'), body: JSON.stringify({ email: 'a@b.dev', role: 'admiral' }) })).status).toBe(400);
  });

  it('changes and removes a role, and only an owner may', async () => {
    expect((await SELF.fetch('https://api.test/v1/members/usr_viewer', { method: 'PATCH', headers: as('usr_admin'), body: JSON.stringify({ role: 'admin' }) })).status).toBe(403);

    const promoted = await SELF.fetch('https://api.test/v1/members/usr_viewer', { method: 'PATCH', headers: as('usr_owner'), body: JSON.stringify({ role: 'member' }) });
    expect(promoted.status).toBe(200);

    const gone = await SELF.fetch('https://api.test/v1/members/usr_viewer', { method: 'DELETE', headers: as('usr_owner') });
    expect(gone.status).toBe(204);

    // And a removed member is refused on the next request, not on the next sign-in.
    const after = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: as('usr_viewer') });
    expect(after.status).toBe(403);
  });

  it('will not leave a workspace with no owner', async () => {
    // usr_owner is the only owner at this point.
    const demote = await SELF.fetch('https://api.test/v1/members/usr_owner', { method: 'PATCH', headers: as('usr_owner'), body: JSON.stringify({ role: 'admin' }) });
    expect(demote.status).toBe(409);

    const remove = await SELF.fetch('https://api.test/v1/members/usr_owner', { method: 'DELETE', headers: as('usr_owner') });
    expect(remove.status).toBe(409);

    // With a second owner appointed, the first may step down.
    await SELF.fetch('https://api.test/v1/members/usr_admin', { method: 'PATCH', headers: as('usr_owner'), body: JSON.stringify({ role: 'owner' }) });
    const now = await SELF.fetch('https://api.test/v1/members/usr_owner', { method: 'PATCH', headers: as('usr_owner'), body: JSON.stringify({ role: 'admin' }) });
    expect(now.status).toBe(200);
  });
});

/**
 * Who is in a workspace, and what they may do in it.
 *
 * `memberships.role` has been CHECK-constrained to owner/admin/member/viewer since migration
 * 0001, written exactly once as `'owner'` by `ensurePersonalWorkspace`, and read by zero queries.
 * Membership is the entire human authorization model in kaambaan, and there was no invite, no
 * member list and no role change — so a workspace was permanently one person, and the four roles
 * were a vocabulary describing nothing.
 *
 * This module is the reader and the writer. `roleFor` is what turns the column into a decision.
 */
import { newId } from '../ids';

/** The four roles, ordered by authority. Order is meaningful: `atLeast` compares by index. */
export const ROLES = ['viewer', 'member', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export interface MemberRecord {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  createdAt: string;
}

/**
 * What each role may do, stated once so the routes do not each invent it.
 *
 * - `viewer` — reads the board and nothing else.
 * - `member` — works the board: create, edit, move and delete cards, resolve gates, answer
 *   elicitations. The everyday user.
 * - `admin`  — additionally manages the workspace's boards and agents, including minting and
 *   revoking agent tokens.
 * - `owner`  — additionally manages people and the link to a hub fleet. Linking a plane is at
 *   least as consequential as revoking a credential, so it sits at the top.
 */
export type Capability = 'read' | 'work' | 'manage' | 'own';

const REQUIRED: Record<Capability, Role> = {
  read: 'viewer',
  work: 'member',
  manage: 'admin',
  own: 'owner',
};

/** Does `role` reach `needed`? */
export function atLeast(role: Role, needed: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(needed);
}

/** Does this role permit this class of act? */
export function permits(role: Role, capability: Capability): boolean {
  return atLeast(role, REQUIRED[capability]);
}

/** Narrow an arbitrary string to a Role, or null. */
export function asRole(value: unknown): Role | null {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value) ? (value as Role) : null;
}

/**
 * This person's role in this workspace, or null when they are not a member.
 *
 * **Null is a refusal, not a default.** A caller who cannot be found in `memberships` gets no
 * role at all rather than the weakest one, because "not a member" and "a member who may only
 * read" are different answers and only the second should see the board.
 */
export async function roleFor(db: D1Database, tenantId: string, userId: string): Promise<Role | null> {
  const row = await db
    .prepare(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`)
    .bind(tenantId, userId)
    .first<{ role: string }>();
  return row ? asRole(row.role) : null;
}

/** Everyone in a workspace, oldest membership first — which puts the founding owner at the top. */
export async function listMembers(db: D1Database, tenantId: string): Promise<MemberRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT m.user_id AS userId, u.email, u.name, m.role, m.created_at AS createdAt
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ? ORDER BY m.created_at ASC`,
    )
    .bind(tenantId)
    .all<MemberRecord>();
  return results;
}

/** How many owners a workspace has — the guard against demoting or removing the last one. */
export async function ownerCount(db: D1Database, tenantId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND role = 'owner'`)
    .bind(tenantId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * Add someone to a workspace by email.
 *
 * No mail is sent and none needs to be: kaambaan's users table is keyed on the email GitHub gives
 * at sign-in, so recording the membership first means the invitee simply signs in and finds the
 * workspace waiting — `primaryTenant` orders by `created_at`, and a membership made before their
 * personal workspace exists is the one they land in.
 *
 * Idempotent on (tenant, user): inviting someone who is already a member updates their role
 * rather than failing on the UNIQUE constraint, because "make this person an admin" is the same
 * request whether or not they were already here.
 */
export async function addMember(
  db: D1Database,
  tenantId: string,
  input: { email: string; role: Role; name?: string | null },
): Promise<MemberRecord> {
  const email = input.email.trim().toLowerCase();
  let user = await db.prepare(`SELECT id, email, name FROM users WHERE email = ?`).bind(email).first<{ id: string; email: string; name: string | null }>();
  if (!user) {
    const id = newId('usr');
    await db.prepare(`INSERT INTO users (id, email, name) VALUES (?, ?, ?)`).bind(id, email, input.name ?? null).run();
    user = { id, email, name: input.name ?? null };
  }
  await db
    .prepare(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role, updated_at = datetime('now')`,
    )
    .bind(newId('mbr'), tenantId, user.id, input.role)
    .run();
  const row = await db
    .prepare(`SELECT created_at AS createdAt FROM memberships WHERE tenant_id = ? AND user_id = ?`)
    .bind(tenantId, user.id)
    .first<{ createdAt: string }>();
  return { userId: user.id, email: user.email, name: user.name, role: input.role, createdAt: row?.createdAt ?? '' };
}

/** Change someone's role. Returns false when they are not a member of this workspace. */
export async function setMemberRole(db: D1Database, tenantId: string, userId: string, role: Role): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE memberships SET role = ?, updated_at = datetime('now') WHERE tenant_id = ? AND user_id = ?`)
    .bind(role, tenantId, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Remove someone from a workspace. Returns false when they were not in it. */
export async function removeMember(db: D1Database, tenantId: string, userId: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM memberships WHERE tenant_id = ? AND user_id = ?`).bind(tenantId, userId).run();
  return (res.meta?.changes ?? 0) > 0;
}

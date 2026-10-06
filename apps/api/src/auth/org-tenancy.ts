/**
 * Where a plane token lands here: the tenant its `org` maps to (created on first sight), and the
 * local user its `sub` maps to (adopted or created once, then found by `sub` forever).
 *
 * Adoption mirrors `hub-oauth.ts` `signInFromHubToken` steps 1–3 and keeps both of its guards:
 * `email_verified === true`, and "the candidate has no mapping yet". A row still mapped to the hub
 * (`agentpod`) is NOT adoptable — the P4 re-point script moves it, so nothing here has to guess.
 */
import { newId } from '../ids';
import {
  findTenantByExternal,
  findUserByEmail,
  findUserByExternal,
  setUserExternalMapping,
  upsertUserByEmail,
  type UserRecord,
} from '../db/catalog';
import { roleFor, type Role } from '../db/members';
import { ORG_PLANE_SOURCE, type OrgPlaneClaims } from './org-plane';

export async function ensureOrgTenant(db: D1Database, org: string): Promise<string> {
  const existing = await findTenantByExternal(db, ORG_PLANE_SOURCE, org);
  if (existing) return existing;
  const id = newId('tnt');
  // OR IGNORE + the partial unique index (migration 0017): a concurrent first sight loses quietly
  // and reads the winner's row below.
  await db
    .prepare(`INSERT OR IGNORE INTO tenants (id, slug, name, external_source, external_id) VALUES (?, ?, 'Workspace', ?, ?)`)
    .bind(id, `ws-${org.slice(4, 14)}-${id.slice(-6)}`, ORG_PLANE_SOURCE, org)
    .run();
  const after = await findTenantByExternal(db, ORG_PLANE_SOURCE, org);
  if (!after) throw new Error('first sight could not create the workspace tenant');
  return after;
}

export interface OrgHuman {
  userId: string;
  role: Role;
}

export async function provisionOrgHuman(
  db: D1Database,
  tenantId: string,
  claims: Pick<OrgPlaneClaims, 'sub' | 'email' | 'email_verified'>,
): Promise<OrgHuman | null> {
  let user: UserRecord | null = await findUserByExternal(db, ORG_PLANE_SOURCE, claims.sub);
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';

  if (!user && email !== '' && claims.email_verified === true) {
    const candidate = await findUserByEmail(db, email);
    if (candidate && !candidate.externalId) {
      await setUserExternalMapping(db, candidate.id, { externalSource: ORG_PLANE_SOURCE, externalId: claims.sub });
      user = candidate;
    } else if (!candidate) {
      const created = await upsertUserByEmail(db, { email, name: null });
      await setUserExternalMapping(db, created.id, { externalSource: ORG_PLANE_SOURCE, externalId: claims.sub });
      user = created;
    }
  }
  if (!user) return null;

  // One statement decides owner-vs-member, so two first arrivals cannot both see an empty tenant.
  await db
    .prepare(
      `INSERT OR IGNORE INTO memberships (id, tenant_id, user_id, role)
       SELECT ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM memberships WHERE tenant_id = ?) THEN 'member' ELSE 'owner' END`,
    )
    .bind(newId('mbr'), tenantId, user.id, tenantId)
    .run();
  const role = await roleFor(db, tenantId, user.id);
  return role ? { userId: user.id, role } : null;
}

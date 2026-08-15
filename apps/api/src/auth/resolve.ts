/**
 * Edge auth resolution (docs/02). Real auth first: a signed session cookie identifies a human; a
 * `kbn_` bearer token identifies an agent (looked up in the catalog). The legacy dev headers
 * (`X-Tenant-Id` / `X-Agent-Id` / `X-User-Id`) are accepted as a fallback only when `DEV_AUTH` is
 * explicitly `"true"` — it is opt-in (set by `pnpm dev` and the test runner, never in
 * wrangler.jsonc), so any deploy requires real credentials by default.
 */
import type { Env } from '../env';
import { readSessionToken, verifySession } from './session';
import { hashToken } from './agent-token';
import { findAgentByTokenHash, findTenantByExternal } from '../db/catalog';
import { verifyHubToken } from './hub-jwt';

export interface UserPrincipal {
  userId: string;
  tenantId: string;
  name?: string;
  login?: string;
  avatarUrl?: string;
}

export interface AgentPrincipal {
  tenantId: string;
  /**
   * The authenticated agent. A `kbn_` token always resolves one: it is compared against
   * `run.agent_id` on every run verb and on the run read, so an agent only drives and reads its own
   * runs. Null only in `DEV_AUTH` mode when no `X-Agent-Id` was sent — there is no identity to
   * compare and the lease alone authorizes; the claim route refuses it outright.
   */
  agentId: string | null;
  /** From the token's agent (catalog); null in dev where capabilities come from the request body. */
  capabilities: string[] | null;
}

function devAuth(env: Env): boolean {
  return env.DEV_AUTH === 'true';
}

function bearer(request: Request): string | null {
  const m = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** Resolve the human behind a request (session cookie, or dev headers). */
export async function resolveUser(request: Request, env: Env): Promise<UserPrincipal | null> {
  const token = readSessionToken(request);
  if (token && env.SESSION_SECRET) {
    const session = await verifySession(token, env.SESSION_SECRET);
    if (session) {
      return { userId: session.userId, tenantId: session.tenantId, name: session.name, login: session.login, avatarUrl: session.avatarUrl };
    }
  }
  if (devAuth(env)) {
    // Browsers can't set headers on a WebSocket upgrade, so the live feed passes ?tenant= instead.
    const tenantId = request.headers.get('X-Tenant-Id') ?? new URL(request.url).searchParams.get('tenant');
    if (tenantId && tenantId.trim() !== '') {
      return { userId: request.headers.get('X-User-Id') ?? 'usr_dev', tenantId };
    }
  }
  return null;
}

/** Resolve the agent behind a request (kbn_ bearer token → catalog, or dev headers). */
export async function resolveAgent(request: Request, env: Env): Promise<AgentPrincipal | null> {
  const token = bearer(request);
  if (token && token.startsWith('kbn_')) {
    const found = await findAgentByTokenHash(env.DB, await hashToken(token));
    return found ? { tenantId: found.tenantId, agentId: found.agentId, capabilities: found.capabilities } : null;
  }
  if (devAuth(env)) {
    // Dev: the tenant (X-Tenant-Id) locates the board DO; X-Agent-Id identifies the agent. Sending
    // it makes local runs behave exactly like a deployed one (identity-checked run verbs); omitting
    // it falls back to lease-only authorization, which is a dev convenience and nothing more.
    const tenantId = request.headers.get('X-Tenant-Id');
    if (tenantId && tenantId.trim() !== '') {
      const agentId = request.headers.get('X-Agent-Id');
      return { tenantId, agentId: agentId && agentId.trim() !== '' ? agentId : null, capabilities: null };
    }
  }
  return null;
}

/**
 * Resolve a human from a token issued by the suite's hub, verified offline.
 *
 * Deliberately a SEPARATE function rather than another branch inside
 * `resolveUser`: this is the first endpoint to accept a hub token, and keeping
 * the seam narrow means the blast radius of getting it wrong is one route
 * instead of the whole surface. Widening it is a later, deliberate step.
 *
 * Two refusals worth naming, because both fail closed:
 *
 *   - **No issuer configured** → no hub-token path at all. A standalone board
 *     must work with no issuer anywhere, and an unset issuer must never mean
 *     "trust any issuer".
 *   - **A verified token whose tenant maps to nothing here** → refused. The
 *     claim names AgentPod's boundary (`fleet_…`); ours is `tnt_…`, and neither
 *     product mints the other's ids. With no mapping there is no tenant to act
 *     in, and falling back to a default would hand one board's data to a token
 *     that never named it.
 */
export async function resolveHubUser(request: Request, env: Env): Promise<UserPrincipal | null> {
  const issuer = env.HUB_ISSUER;
  if (!issuer) return null;

  const token = bearer(request);
  // `kbn_` tokens are the agent credential and are resolved elsewhere; anything
  // else is a candidate JWT.
  if (!token || token.startsWith('kbn_')) return null;

  const claims = await verifyHubToken(token, { issuer });
  if (!claims) return null;

  const tenantId = await findTenantByExternal(env.DB, 'agentpod', claims.tenant);
  if (!tenantId) return null;

  return { userId: claims.sub, tenantId };
}

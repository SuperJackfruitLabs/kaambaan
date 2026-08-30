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
  /**
   * What this caller is permitted to dispatch, from a verified hub token.
   *
   * Present only when the caller authenticated with one — a session cookie
   * carries no grant, and `undefined` therefore means "no authority
   * accompanied this act", which is not the same as an empty grant.
   */
  mayDispatch?: string[];
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
  /**
   * The agent's mapped suite principal id (`agents.external_id`), already known from the same
   * catalog row a `kbn_` token resolves. **Absent** (not `null`) when this auth path never looked
   * it up — the dev-header path, which carries no DB-backed identity at all — so a consumer can
   * tell "resolved, and there is none" from "not resolved here, look it up yourself".
   */
  externalId?: string | null;
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
    return found
      ? { tenantId: found.tenantId, agentId: found.agentId, capabilities: found.capabilities, externalId: found.externalId }
      : null;
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
 * `resolveUser`, so the hub-token path is one readable thing rather than a
 * condition buried in the session path.
 *
 * **Corrected 2026-08-30.** This comment used to say "this is the first
 * endpoint to accept a hub token, and keeping the seam narrow means the blast
 * radius of getting it wrong is one route instead of the whole surface." That
 * stopped being true: `index.ts` calls this for every human route (and, for
 * GET, on the board-list path above it). The widening happened; the comment
 * did not. Read as written it would tell a reviewer that approving a gate with
 * a hub token needs new wiring, when in fact it already worked — which is
 * exactly the kind of drift `charter`'s README warns about, a claim about code
 * kept somewhere the code cannot contradict it.
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

  return { userId: claims.sub, tenantId, mayDispatch: claims.mayDispatch ?? [] };
}

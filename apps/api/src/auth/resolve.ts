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
import { findAgentByTokenHash } from '../db/catalog';

export interface UserPrincipal {
  userId: string;
  tenantId: string;
  name?: string;
  login?: string;
  avatarUrl?: string;
}

export interface AgentPrincipal {
  tenantId: string;
  /** The claiming agent. Null is allowed for run verbs (authorized by the lease, not identity); the
   * claim route requires it. */
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
    // Dev: the tenant (X-Tenant-Id) locates the board DO; X-Agent-Id identifies the claiming agent
    // (only the claim route needs it — run verbs are authorized by the run's lease).
    const tenantId = request.headers.get('X-Tenant-Id');
    if (tenantId && tenantId.trim() !== '') {
      const agentId = request.headers.get('X-Agent-Id');
      return { tenantId, agentId: agentId && agentId.trim() !== '' ? agentId : null, capabilities: null };
    }
  }
  return null;
}

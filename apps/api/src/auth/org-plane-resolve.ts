/**
 * Plane-mode resolution: the three siblings of `resolveHubUser` / `resolveHubAgent` /
 * `resolveHubService`, with the same refusals, keyed by `org` instead of `tenant`.
 */
import type { Env } from '../env';
import type { UserPrincipal, AgentPrincipal, ServicePrincipal } from './resolve';
import { findAgentByExternal, findTenantByExternal } from '../db/catalog';
import { entitles, orgPlaneMode, verifyOrgPlaneToken, ORG_PLANE_SOURCE, type OrgPlaneClaims, type OrgPlaneConfig } from './org-plane';
import { ensureOrgTenant, provisionOrgHuman } from './org-tenancy';
import type { McpAuth } from '../mcp/tools';
import { effectiveCapabilities } from '../db/implications';

export function bearerOf(request: Request): string | null {
  const m = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** One verify per (request, audience): the entitlement gate and the resolver share it. */
const memo = new WeakMap<Request, Map<string, Promise<OrgPlaneClaims | null>>>();

export function planeClaimsFor(request: Request, cfg: OrgPlaneConfig, audience: string): Promise<OrgPlaneClaims | null> {
  const token = bearerOf(request);
  // `spa_` is superpipeline's own credential and never a JWT; a value without two dots is not one either.
  if (!token || token.startsWith('spa_') || token.split('.').length !== 3) return Promise.resolve(null);
  let byAud = memo.get(request);
  if (!byAud) memo.set(request, (byAud = new Map()));
  let p = byAud.get(audience);
  if (!p) byAud.set(audience, (p = verifyOrgPlaneToken(token, cfg, audience)));
  return p;
}

/**
 * An agent's or service's grant scopes, from its token's `scope` (contract §2: read grant scopes
 * only from agent/service tokens). Absent means NO scopes — `[]`, never `null`, which
 * `scopePermits` would read as an unscoped credential and permit everything.
 */
export function grantScopes(claims: Pick<OrgPlaneClaims, 'scope'>): string[] {
  return typeof claims.scope === 'string' ? claims.scope.split(' ').filter((s) => s !== '') : [];
}

export function productNotEnabled(org: string): Response {
  return Response.json({ error: 'product_not_enabled', org }, { status: 403 });
}

/** The contract §2 refusal, before any route runs. Null when it does not apply. */
export async function entitlementRefusal(request: Request, env: Env): Promise<Response | null> {
  const mode = orgPlaneMode(env);
  if (mode.kind !== 'on') return null;
  const path = new URL(request.url).pathname;
  const audience = path === '/mcp' ? mode.cfg.mcpAudience : mode.cfg.audience;
  const claims = await planeClaimsFor(request, mode.cfg, audience);
  return claims && !entitles(claims) ? productNotEnabled(claims.org) : null;
}

export async function resolvePlaneUser(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<UserPrincipal | null> {
  const claims = await planeClaimsFor(request, cfg, cfg.audience);
  if (!claims || !entitles(claims) || claims.principalKind !== 'human') return null;
  const tenantId = await ensureOrgTenant(env.DB, claims.org);
  const human = await provisionOrgHuman(env.DB, tenantId, claims);
  if (!human) {
    // Logged without claims: the useful fact is that a verified person could not be placed.
    console.warn('org-plane: a verified human could not be provisioned (unverified address, or an address held by a still-hub-mapped account)');
    return null;
  }
  return { userId: human.userId, tenantId, role: human.role, mayDispatch: claims.mayDispatch };
}

export async function resolvePlaneAgent(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<AgentPrincipal | null> {
  const claims = await planeClaimsFor(request, cfg, cfg.audience);
  if (!claims || !entitles(claims) || claims.principalKind !== 'agent') return null;
  const found = await findAgentByExternal(env.DB, ORG_PLANE_SOURCE, claims.sub);
  if (!found) return null;
  const tenantId = await findTenantByExternal(env.DB, ORG_PLANE_SOURCE, claims.org);
  if (!tenantId || tenantId !== found.tenantId) return null;
  return {
    tenantId: found.tenantId,
    agentId: found.agentId,
    capabilities: found.capabilities,
    concurrency: found.concurrency,
    externalId: claims.sub,
    scopes: grantScopes(claims),
    mayDispatch: claims.mayDispatch,
    queueing: {
      ownerUserId: found.ownerUserId,
      mayQueueTo: found.mayQueueTo,
      queueCeilingPerHour: found.queueCeilingPerHour,
      boardCeilingPerDay: found.boardCeilingPerDay,
    },
  };
}

export async function resolvePlaneService(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<ServicePrincipal | null> {
  const claims = await planeClaimsFor(request, cfg, cfg.audience);
  if (!claims || !entitles(claims) || claims.principalKind !== 'service') return null;
  const tenantId = await findTenantByExternal(env.DB, ORG_PLANE_SOURCE, claims.org);
  if (!tenantId) return null;
  return { principalId: claims.sub, tenantId, scopes: grantScopes(claims) };
}

export async function resolvePlaneMcp(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<McpAuth | null> {
  const claims = await planeClaimsFor(request, cfg, cfg.mcpAudience);
  if (!claims || !entitles(claims)) return null;
  if (claims.principalKind === 'agent') {
    const found = await findAgentByExternal(env.DB, ORG_PLANE_SOURCE, claims.sub);
    if (!found) return null;
    const tenantId = await findTenantByExternal(env.DB, ORG_PLANE_SOURCE, claims.org);
    if (!tenantId || tenantId !== found.tenantId) return null;
    return {
      tenantId,
      agentId: found.agentId,
      capabilities: await effectiveCapabilities(env.DB, tenantId, found.capabilities),
      scopes: grantScopes(claims),
      externalId: claims.sub,
    };
  }
  if (claims.principalKind === 'human') {
    const tenantId = await ensureOrgTenant(env.DB, claims.org);
    const human = await provisionOrgHuman(env.DB, tenantId, claims);
    if (!human) return null;
    // `scopes: []` registers only the unscoped (read) tools — TOOL_SCOPE gates the rest.
    return { tenantId, agentId: human.userId, capabilities: [], scopes: [], externalId: claims.sub };
  }
  return null;
}

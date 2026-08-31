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
import { findAgentByExternal, findAgentByTokenHash, findTenantByExternal } from '../db/catalog';
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
 * Three refusals worth naming, because all three fail closed:
 *
 *   - **No issuer configured** → no hub-token path at all. A standalone board
 *     must work with no issuer anywhere, and an unset issuer must never mean
 *     "trust any issuer".
 *   - **A verified token whose tenant maps to nothing here** → refused. The
 *     claim names AgentPod's boundary (`fleet_…`); ours is `tnt_…`, and neither
 *     product mints the other's ids. With no mapping there is no tenant to act
 *     in, and falling back to a default would hand one board's data to a token
 *     that never named it.
 *   - **A verified token whose `principalKind` is not `"human"`** → refused. Since
 *     `charter → decisions/2026-08-30-an-agent-is-a-principal.md` a node can exchange its own
 *     credential for a token naming a station's agent principal, so "a valid hub token" and
 *     "a person" stopped being the same thing. `resolveHubAgent` refuses the converse for the
 *     same reason and says so in the same words: one plane's credential must not double as the
 *     other kind just because it verifies.
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
  // An agent's token must never double as a human credential — the exact mirror of the refusal
  // `resolveHubAgent` has always made in the other direction, and the more dangerous half now
  // that a node can mint an agent-kind token for any station it hosts. Anything that is not a
  // human (`agent`, `service`, or a kind this issuer has yet to invent) fails closed here,
  // because this function is `index.ts`'s fallback for EVERY non-agent route and method.
  if (claims.principalKind !== 'human') return null;

  const tenantId = await findTenantByExternal(env.DB, 'agentpod', claims.tenant);
  if (!tenantId) return null;

  return { userId: claims.sub, tenantId, mayDispatch: claims.mayDispatch ?? [] };
}

/**
 * Resolve an agent from a token issued by the suite's hub, verified offline.
 *
 * The agent-kind sibling of `resolveHubUser` above — same shape, deliberately: a node can now
 * exchange its own credential for a short-lived hub token whose `sub` is a bare `prn_…`
 * principal id and whose `principalKind` is `"agent"` (charter
 * decisions/2026-08-30-an-agent-is-a-principal.md), and kaambaan must accept it AS THAT AGENT.
 *
 * **Capabilities never come from the claim.** They are kaambaan's own vocabulary — charter
 * decisions/2026-08-15-a-grant-names-an-agent-per-plane.md calls putting them in a cross-plane
 * claim "a trap — the same word, two vocabularies". The token names a principal (`sub`);
 * `findAgentByExternal` looks up kaambaan's OWN `agents` row for that principal and its
 * capabilities come from there, never from the token.
 *
 * Four refusals, all failing closed, same posture as `resolveHubUser`:
 *
 *   - **No issuer configured** → no hub-token path at all. A standalone board works with no
 *     issuer anywhere.
 *   - **A `sub` that maps to no local agent** → refused, not admitted with a null agent. There is
 *     no capability set to act with.
 *   - **`principalKind` is not `"agent"`** → refused. A human's token must never double as an
 *     agent credential just because its `sub` happens to also be mapped as one.
 *   - **The claim's `tenant` does not map to the SAME kaambaan tenant the agent row names** →
 *     refused. `resolveHubUser` already maps `claims.tenant` through `findTenantByExternal` and
 *     refuses an unmapped one; this mirrors that rather than trusting the agent row alone, so a
 *     token minted for one fleet cannot resolve into an agent whose row happens to sit in a
 *     different kaambaan tenant. charter → decisions/2026-08-15-tenancy-is-local-and-mapped.md:
 *     an unmapped tenant is "invisible to the other plane, and silently so" — the check makes
 *     that invisibility a refusal instead of a silent cross-tenant hop.
 */
export async function resolveHubAgent(request: Request, env: Env): Promise<AgentPrincipal | null> {
  const issuer = env.HUB_ISSUER;
  if (!issuer) return null;

  const token = bearer(request);
  // `kbn_` tokens are the native agent credential and are resolved elsewhere; anything else is a
  // candidate JWT.
  if (!token || token.startsWith('kbn_')) return null;

  const claims = await verifyHubToken(token, { issuer });
  if (!claims) return null;
  if (claims.principalKind !== 'agent') return null;

  const found = await findAgentByExternal(env.DB, 'org-plane', claims.sub);
  if (!found) return null;

  // Same mapping resolveHubUser performs on the human path — the claim's tenant must land on the
  // exact kaambaan tenant the agent row names, not merely on some tenant. A mismatch is a
  // cross-fleet confusion nothing else in this path would catch.
  const claimTenantId = await findTenantByExternal(env.DB, 'agentpod', claims.tenant);
  if (!claimTenantId || claimTenantId !== found.tenantId) return null;

  return { tenantId: found.tenantId, agentId: found.agentId, capabilities: found.capabilities, externalId: claims.sub };
}

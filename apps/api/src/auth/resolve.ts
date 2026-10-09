/**
 * Edge auth resolution (docs/02). Real auth first: a signed session cookie identifies a human; a
 * `spa_` bearer token identifies an agent (looked up in the catalog). The legacy dev headers
 * (`X-Tenant-Id` / `X-Agent-Id` / `X-User-Id`) are accepted as a fallback only when `DEV_AUTH` is
 * explicitly `"true"` — it is opt-in (set by `pnpm dev` and the test runner, never in
 * wrangler.jsonc), so any deploy requires real credentials by default.
 */
import type { Env } from '../env';
import { readSessionToken, verifySession } from './session';
import { hashToken } from './agent-token';
import {
  findAgentByExternal,
  findAgentByTokenHash,
  findTenantByExternal,
  findUserByExternal,
  type AgentQueueingPolicy,
} from '../db/catalog';
import { roleFor, type Role } from '../db/members';
import { verifyHubToken, planeAudience } from './hub-jwt';
import { orgPlaneMode } from './org-plane';
import { resolvePlaneUser, resolvePlaneAgent, resolvePlaneService } from './org-plane-resolve';

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
  /**
   * This caller's role in the workspace (`memberships.role`).
   *
   * **Null means "not a member here"**, and every gate refuses on it — including reads. A person
   * whose membership was removed still holds a valid session cookie naming that tenant, and
   * "not a member" must not resolve to the weakest role that can still see the board.
   */
  role: Role | null;
  name?: string;
  login?: string;
  avatarUrl?: string;
}

export interface AgentPrincipal {
  tenantId: string;
  /**
   * The authenticated agent. A `spa_` token always resolves one: it is compared against
   * `run.agent_id` on every run verb and on the run read, so an agent only drives and reads its own
   * runs. Null only in `DEV_AUTH` mode when no `X-Agent-Id` was sent — there is no identity to
   * compare and the lease alone authorizes; the claim route refuses it outright.
   */
  agentId: string | null;
  /** From the token's agent (catalog); null in dev where capabilities come from the request body. */
  capabilities: string[] | null;
  /**
   * The agent's mapped suite principal id (`agents.external_id`), already known from the same
   * catalog row a `spa_` token resolves. **Absent** (not `null`) when this auth path never looked
   * it up — the dev-header path, which carries no DB-backed identity at all — so a consumer can
   * tell "resolved, and there is none" from "not resolved here, look it up yourself".
   */
  externalId?: string | null;
  /**
   * The scopes on the `spa_` token that authenticated this request (`agent_tokens.scopes_json`).
   *
   * **Null means "this credential is not a superpipeline token"** — a hub-issued agent token, or a dev
   * header — not "no scopes". The distinction is load-bearing: `scopePermits` treats null as
   * unscoped-and-therefore-unrestricted, because a hub token's authority is the hub's and is
   * checked by the control pair at claim time, not by a scope superpipeline never minted.
   */
  scopes?: string[] | null;
  /**
   * The ceiling the operator set on how many cards this agent may hold (`agents.concurrency`).
   * Absent on the paths that never read the catalog row.
   */
  concurrency?: number;
  /**
   * The control pair's first half, as THIS agent holds it — the principals it may itself dispatch.
   *
   * Present only from the hub-token path, because only the hub knows it: the grant is set with
   * `fleet grants set` and travels in the token's claims, exactly as a human's does. A `spa_`
   * token carries no claims, so this is **absent** there — and absent is not `[]`. The hub's own
   * contract says so ("ABSENT from one that does not, and the difference matters — absent must not
   * be read as 'permitted nothing'"), and the queueing route reads the two differently: an empty
   * grant is an operator's decision, an absent one is a credential that cannot speak to the
   * question at all.
   *
   * This is what an agent-queued card's `queuedGrant` is built from. Nothing copies it into this
   * plane: a stored copy would keep authorising dispatches after the operator revoked them.
   */
  mayDispatch?: string[];
  /**
   * What the operator set on the agent row for queueing work of its own (migration 0015): the
   * human an agent-queued card belongs to, which boards may receive one, and how many per hour.
   *
   * Absent on the dev-header path, which reads no catalog row at all.
   */
  queueing?: AgentQueueingPolicy;
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
      return {
        userId: session.userId,
        tenantId: session.tenantId,
        // Read now rather than carried in the cookie: a role change must take effect on the next
        // request, not when a stateless session happens to be reissued. Removing someone's
        // membership is a revocation, and a revocation that waits is not one.
        role: await roleFor(env.DB, session.tenantId, session.userId),
        name: session.name,
        login: session.login,
        avatarUrl: session.avatarUrl,
      };
    }
  }
  if (devAuth(env)) {
    // Browsers can't set headers on a WebSocket upgrade, so the live feed passes ?tenant= instead.
    const tenantId = request.headers.get('X-Tenant-Id') ?? new URL(request.url).searchParams.get('tenant');
    if (tenantId && tenantId.trim() !== '') {
      const userId = request.headers.get('X-User-Id') ?? 'usr_dev';
      // Dev headers are already a FULL credential for the tenant by construction (that is why
      // they are opt-in and absent from wrangler.jsonc), so a workspace with NO members at all —
      // a bare dev or test tenant, which nothing in dev creates memberships for — grants the top
      // role rather than refusing everyone.
      //
      // But once a workspace HAS members, the dev header must name one of them. Otherwise the
      // fallback would quietly outrank the roles it is meant to be standing in for, and every
      // role test would pass by not being applied.
      const role = await roleFor(env.DB, tenantId, userId);
      if (role) return { userId, tenantId, role };
      const populated = await env.DB.prepare(`SELECT 1 FROM memberships WHERE tenant_id = ? LIMIT 1`).bind(tenantId).first();
      return { userId, tenantId, role: populated ? null : 'owner' };
    }
  }
  return null;
}

/** Resolve the agent behind a request (spa_ bearer token → catalog, or dev headers). */
export async function resolveAgent(request: Request, env: Env): Promise<AgentPrincipal | null> {
  const token = bearer(request);
  if (token && token.startsWith('spa_')) {
    const found = await findAgentByTokenHash(env.DB, await hashToken(token));
    return found
      ? {
          tenantId: found.tenantId,
          agentId: found.agentId,
          capabilities: found.capabilities,
          externalId: found.externalId,
          scopes: found.scopes,
          concurrency: found.concurrency,
          queueing: {
            ownerUserId: found.ownerUserId,
            mayQueueTo: found.mayQueueTo,
            queueCeilingPerHour: found.queueCeilingPerHour,
            boardCeilingPerDay: found.boardCeilingPerDay,
          },
          // No `mayDispatch`. A `spa_` token carries no claims, so this credential cannot say what
          // the agent may dispatch — which is different from saying it may dispatch nothing.
        }
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
  // The Organization plane replaces the hub; it does not join it (contract §1, no dual-accept).
  // `invalid` — the switch set, the rest missing — refuses everything rather than fall back.
  const plane = orgPlaneMode(env);
  if (plane.kind === 'on') return resolvePlaneUser(request, env, plane.cfg);
  if (plane.kind === 'invalid') return null;

  const issuer = env.HUB_ISSUER;
  if (!issuer) return null;

  const token = bearer(request);
  // `spa_` tokens are the agent credential and are resolved elsewhere; anything
  // else is a candidate JWT.
  if (!token || token.startsWith('spa_')) return null;

  const claims = await verifyHubToken(token, { issuer, audience: planeAudience(request, env) });
  if (!claims) return null;
  // An agent's token must never double as a human credential — the exact mirror of the refusal
  // `resolveHubAgent` has always made in the other direction, and the more dangerous half now
  // that a node can mint an agent-kind token for any station it hosts. Anything that is not a
  // human (`agent`, `service`, or a kind this issuer has yet to invent) fails closed here,
  // because this function is `index.ts`'s fallback for EVERY non-agent route and method.
  if (claims.principalKind !== 'human') return null;

  const tenantId = await findTenantByExternal(env.DB, 'agentpod', claims.tenant);
  if (!tenantId) return null;

  // A hub token names a SUBJECT in the fleet — `claims.sub`, which for a session or exchange
  // token is a Better Auth user id, not a `prn_…` principal id (the hub's jwt plugin overwrites
  // `sub` with `session.user.id` after building the payload). If someone has linked that subject
  // to a user here, they ARE that user: their real role, and their local id on anything they
  // write. If nobody has, they are a stranger holding a valid credential, and `member` is what a
  // stranger gets — the same rule as before, now reached only when the mapping says nothing.
  //
  // That the two ids differ is load-bearing: a token for the SAME human minted on the station or
  // bridge path carries `sub = prn_…`, which this mapping can never match, so an approval
  // arriving that way still resolves as a stranger even after linking. Recorded as an open
  // question in docs/superpowers/specs/2026-09-20-suite-sign-in-design.md; closing it is a change
  // to what both mint paths put in `sub`, not something this lookup may paper over.
  const linked = await findUserByExternal(env.DB, 'agentpod', claims.sub);
  if (linked) {
    const role = await roleFor(env.DB, tenantId, linked.id);
    return { userId: linked.id, tenantId, role: role ?? 'member', mayDispatch: claims.mayDispatch ?? [] };
  }
  return { userId: claims.sub, tenantId, role: 'member', mayDispatch: claims.mayDispatch ?? [] };
}

/**
 * A person from an ORGANIZATION-PLANE bearer, and from nothing else.
 *
 * The credential the operator acts reach a terminal with: defining a capability, creating an agent
 * linked to a principal, and minting an agent's tokens. Those were session-cookie only, so `supi` —
 * which carries exactly this token — was answered 401 on all three.
 *
 * Narrower than `resolveHubUser` on purpose. That function is the legacy hub's path too, where an
 * unmapped subject is admitted as a `member` and the mapping between the two id spaces has a known
 * open question (see its comment); the boundary these routes kept against hub tokens is kept. In
 * plane mode the two are the same function, so nothing a hub token could do changes.
 *
 * The role still decides — this resolves who the person is, never what they may do — and only a
 * `principalKind: "human"` token resolves at all (`resolvePlaneUser`), so an agent-kind token is
 * never a person here.
 */
export async function resolveOrgPlaneUser(request: Request, env: Env): Promise<UserPrincipal | null> {
  const plane = orgPlaneMode(env);
  if (plane.kind !== 'on') return null;
  return resolvePlaneUser(request, env, plane.cfg);
}

/**
 * Resolve an agent from a token issued by the suite's hub, verified offline.
 *
 * The agent-kind sibling of `resolveHubUser` above — same shape, deliberately: a node can now
 * exchange its own credential for a short-lived hub token whose `sub` is a bare `prn_…`
 * principal id and whose `principalKind` is `"agent"` (charter
 * decisions/2026-08-30-an-agent-is-a-principal.md), and superpipeline must accept it AS THAT AGENT.
 *
 * **Capabilities never come from the claim.** They are superpipeline's own vocabulary — charter
 * decisions/2026-08-15-a-grant-names-an-agent-per-plane.md calls putting them in a cross-plane
 * claim "a trap — the same word, two vocabularies". The token names a principal (`sub`);
 * `findAgentByExternal` looks up superpipeline's OWN `agents` row for that principal and its
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
 *   - **The claim's `tenant` does not map to the SAME superpipeline tenant the agent row names** →
 *     refused. `resolveHubUser` already maps `claims.tenant` through `findTenantByExternal` and
 *     refuses an unmapped one; this mirrors that rather than trusting the agent row alone, so a
 *     token minted for one fleet cannot resolve into an agent whose row happens to sit in a
 *     different superpipeline tenant. charter → decisions/2026-08-15-tenancy-is-local-and-mapped.md:
 *     an unmapped tenant is "invisible to the other plane, and silently so" — the check makes
 *     that invisibility a refusal instead of a silent cross-tenant hop.
 */
export async function resolveHubAgent(request: Request, env: Env): Promise<AgentPrincipal | null> {
  // The Organization plane replaces the hub; it does not join it (contract §1, no dual-accept).
  // `invalid` — the switch set, the rest missing — refuses everything rather than fall back.
  const plane = orgPlaneMode(env);
  if (plane.kind === 'on') return resolvePlaneAgent(request, env, plane.cfg);
  if (plane.kind === 'invalid') return null;

  const issuer = env.HUB_ISSUER;
  if (!issuer) return null;

  const token = bearer(request);
  // `spa_` tokens are the native agent credential and are resolved elsewhere; anything else is a
  // candidate JWT.
  if (!token || token.startsWith('spa_')) return null;

  const claims = await verifyHubToken(token, { issuer, audience: planeAudience(request, env) });
  if (!claims) return null;
  if (claims.principalKind !== 'agent') return null;

  const found = await findAgentByExternal(env.DB, 'org-plane', claims.sub);
  if (!found) return null;

  // Same mapping resolveHubUser performs on the human path — the claim's tenant must land on the
  // exact superpipeline tenant the agent row names, not merely on some tenant. A mismatch is a
  // cross-fleet confusion nothing else in this path would catch.
  const claimTenantId = await findTenantByExternal(env.DB, 'agentpod', claims.tenant);
  if (!claimTenantId || claimTenantId !== found.tenantId) return null;

  return {
    tenantId: found.tenantId,
    agentId: found.agentId,
    capabilities: found.capabilities,
    concurrency: found.concurrency,
    externalId: claims.sub,
    // Carried, not dropped. This function has always received the grant and thrown it away, which
    // left the one credential that KNOWS what an agent may dispatch unable to say so — the mirror
    // image of the field-with-no-consumer this estate keeps hitting. `?? []` is deliberately NOT
    // written here: an issuer that does not speak this claim must stay distinguishable from one
    // that speaks it and grants nothing.
    mayDispatch: claims.mayDispatch,
    queueing: {
      ownerUserId: found.ownerUserId,
      mayQueueTo: found.mayQueueTo,
      queueCeilingPerHour: found.queueCeilingPerHour,
      boardCeilingPerDay: found.boardCeilingPerDay,
    },
  };
}

/** Read a run's evidence (superwitness contract C4). */
export const EVIDENCE_READ = 'evidence:read';
/** Read boards and cards as a service (Superlibrary's ingest). */
export const CARDS_READ = 'cards:read';
/** Register a push config as a service, for record events only. */
export const PUSH_WRITE = 'push:write';

export interface ServicePrincipal {
  /** The hub's `prn_…`. Not a local user or agent: a service has neither here. */
  principalId: string;
  tenantId: string;
  /**
   * From the token's `scope` claim, split on spaces. Empty when absent. These are the scopes as
   * minted: a hub-side narrowing or revocation reaches superpipeline only when the token expires
   * (the hub's TOKEN_TTL).
   */
  scopes: string[];
}

/**
 * Resolve a SERVICE-kind hub token — superwitness, reading evidence.
 *
 * The third sibling of `resolveHubUser` and `resolveHubAgent`, with the same refusals: no issuer
 * configured, a kind that is not `service`, a fleet that maps to no tenant here. It grants nothing
 * by itself; a route checks `scopes` for the one permission it needs.
 */
export async function resolveHubService(request: Request, env: Env): Promise<ServicePrincipal | null> {
  // The Organization plane replaces the hub; it does not join it (contract §1, no dual-accept).
  // `invalid` — the switch set, the rest missing — refuses everything rather than fall back.
  const plane = orgPlaneMode(env);
  if (plane.kind === 'on') return resolvePlaneService(request, env, plane.cfg);
  if (plane.kind === 'invalid') return null;

  const issuer = env.HUB_ISSUER;
  if (!issuer) return null;
  const token = bearer(request);
  if (!token || token.startsWith('spa_')) return null;

  const claims = await verifyHubToken(token, { issuer, audience: planeAudience(request, env) });
  if (!claims || claims.principalKind !== 'service') return null;

  const tenantId = await findTenantByExternal(env.DB, 'agentpod', claims.tenant);
  if (!tenantId) return null;

  const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter((s) => s !== '') : [];
  return { principalId: claims.sub, tenantId, scopes };
}

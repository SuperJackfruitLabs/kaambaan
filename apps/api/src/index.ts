/**
 * Superpipeline API — the edge Worker (docs/02-architecture.md). It authenticates, resolves the tenant,
 * and routes board requests to the per-(tenant, board) Board Durable Object, serving the SvelteKit
 * SPA same-origin for everything else.
 *
 * Auth (docs/05 §3). Three principals, resolved before dispatch:
 *   - humans      — a signed `superpipeline_session` cookie from GitHub OAuth (auth/routes.ts). Stateless
 *                   HMAC, no session store. This is what board/card administration requires.
 *   - agents      — a `spa_` bearer on the agent routes only: `…/claims` and `…/runs/*`. The tenant
 *                   AND the agent identity come from the token, never from the request.
 *   - dev headers — `X-Tenant-Id`/`X-Agent-Id`/`?tenant=` are a full credential, so they are gated
 *                   on DEV_AUTH === 'true' and are absent from wrangler.jsonc by design. A deploy
 *                   rejects them. (An earlier version of this comment described them as the primary
 *                   mechanism awaiting "OAuth/magic-link"; real login shipped, and no magic-link was
 *                   ever built.)
 *
 * Both recorded permissions are now checked, where before neither was:
 *   - token `scopes` on the agent routes (auth/scopes.ts) — `claim` to take a card, `run` to drive
 *     one, with `claim` grandfathering `run` for tokens minted before the split.
 *   - `memberships.role` on every human route (db/members.ts) — viewer reads, member works the
 *     board, admin manages boards and agents, owner manages people and the fleet link. A caller
 *     with no membership is refused rather than demoted to a reader.
 */
import {
  BoardDO,
  type StageDef,
  type StagePatch,
  type BoardSnapshot,
  type BoardErrorCode,
  type AgentActivityType,
  type GateDecision,
  type Result,
  type JsonValue,
} from './board/board-do';
import type { LinkKind } from './board/links';
import type { Env } from './env';
import { newId } from './ids';
import { boardStub } from './board/stub';
import { logReporter } from './superwitness/log';
import { reportingEnabled } from './superwitness/config';
import { listExternalLinksFor, addExternalLink, removeExternalLink, deleteExternalLinksForCard } from './db/card-links-external';
import { resolveReferenceInput } from './references/resolve';
import { handleMcpRequest } from './mcp/server';
import { resolveMcpAuth, unauthorized, protectedResourceMetadata, MCP_PROTECTED_RESOURCE_PATH } from './mcp/auth';
import { resolveUser, resolveAgent, type UserPrincipal, type AgentPrincipal, resolveHubUser, resolveHubAgent, resolveHubService, EVIDENCE_READ } from './auth/resolve';
import { handleAuthRoute } from './auth/routes';
import { handleHubRoute } from './auth/hub-oauth';
import { handlePlaneSignInRoute } from './auth/plane-signin';
import { entitlementRefusal } from './auth/org-plane-resolve';
import { orgPlaneMode } from './auth/org-plane';
import { recordBoard, listBoards, listAllBoards, renameBoard, updateBoardStages, deleteBoard, listAgents, createAgent, updateAgent, createAgentToken, revokeAgentToken, deleteAgent, setAgentExternalMapping, findAgentByExternal, agentBelongsToTenant, setTenantExternalMapping, setTenantForgeHost, tenantById, recordAgentQueue, countBoardsComposedToday, principalIdsFor, hubSubjectsFor } from './db/catalog';
import { authorizeAgentQueue } from './auth/agent-queue';
import { stagePatchRefusal } from './auth/scopes';
import {
  AGENT_TOKEN_SCOPES,
  isAgentScope,
  requiredScope,
  scopePermits,
  SCOPE_FORBIDDEN,
  type AgentScope,
} from './auth/scopes';
import { capabilityTag, capabilityTags, stageRequiredCapabilities, isKnownProvider, providerKeys } from '@superpipeline/contract';
import { listMembers, addMember, setMemberRole, removeMember, ownerCount, permits, asRole, mayOwnWork, type Capability } from './db/members';
import {
  listCapabilities,
  createCapability,
  updateCapability,
  deleteCapability,
  capabilityById,
  capabilityUsage,
  ensureCapabilities,
  similarKeys,
} from './db/capabilities';
import { buildAgentCard } from './db/agent-card';
import {
  addImplication,
  effectiveCapabilities,
  listImplications,
  removeImplication,
} from './db/implications';
import {
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  unknownLabelIds,
  resolveLabelNames,
  isLabelNameCollision,
} from './db/labels';
import {
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  projectById,
  listMilestones,
  createMilestone,
  deleteMilestone,
  milestoneById,
  isProjectNameCollision,
  PROJECT_STATES,
  PROJECT_HEALTHS,
  computeRollup,
  cachedRollup,
  listAllProjects,
  type ProjectState,
  type ProjectHealth,
} from './db/projects';
import { withRunTelemetry } from './telemetry/run-telemetry';

export { BoardDO };

const DUE_AT_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `due_at` drives claim order and the overdue cron sweep on a board that runs unattended
 * (board-do.ts `claimableWhere`/`sweepBoard`), so garbage here does not fail loudly at write time
 * — it silently misorders or mis-fires later. Only a bare date (the column's own shape) or `null`
 * is accepted. Shared by the card PATCH route and `createCard` so there is exactly one rule.
 */
function isInvalidDueAt(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== 'string' || !DUE_AT_RE.test(value));
}

/**
 * One code, one status, across the whole API. Every route that gets a `BoardErrorCode` back reads
 * its HTTP status from here — there is no second table anywhere that answers the same code
 * differently. A brief for Task 17a once asked for `NOT_INITIALIZED` to mean 409 on the link
 * routes specifically, while every other route here still answers it 404: a client cannot learn
 * "this code means X, except on these three routes where it means Y" from anything in this file,
 * so that request was wrong and this function stayed the single source of truth. If a future route
 * genuinely needs a code to carry a different status, that is a sign the DO should return a
 * different code for that case, not that this switch should grow a second entry for the same one.
 */
function statusForCode(code: BoardErrorCode): number {
  switch (code) {
    case 'WIP_LIMIT':
      return 409;
    case 'UNKNOWN_STAGE':
    case 'INVALID_URL':
    case 'INVALID_DELIVERY':
    case 'INVALID_USAGE':
    case 'INVALID_STAGES':
      return 400;
    case 'BUDGET_EXCEEDED':
      return 402; // Payment Required — the board/card budget cap was reached
    case 'INVALID_ANSWER':
      return 400;
    case 'CARD_NOT_FOUND':
    case 'RUN_NOT_FOUND':
    case 'NOT_INITIALIZED':
    case 'GATE_NOT_FOUND':
    case 'ELICITATION_NOT_FOUND':
    case 'SCHEDULE_NOT_FOUND':
    case 'NO_SUCH_CARD':
      return 404;
    case 'STALE_LEASE':
    case 'GATE_NOT_PENDING':
    // The question was already settled (answered, or retired with its run) — a conflict with the
    // state the caller believed in, not a bad request. Retrying it will never succeed.
    case 'ELICITATION_NOT_PENDING':
    case 'CARD_NOT_WAITING':
    // The stage still holds cards. A conflict with the state the caller believed in, not a
    // malformed request: the same payload succeeds once the stage is emptied.
    case 'STAGE_NOT_EMPTY':
      return 409;
    case 'SEPARATION_OF_DUTIES':
    // The caller authenticated, but this run is another agent's: a permanent refusal of an
    // understood request, and deliberately NOT the 409 that means "your lease lapsed, re-claim".
    case 'NOT_RUN_OWNER':
      return 403;
    case 'INVALID_SIGNATURE':
      return 401;
    case 'NOT_CONFIGURED':
      return 400;
    case 'INVALID_RULE':
    case 'INVALID_TIMEZONE':
    case 'INVALID_SCHEDULE':
      return 400;
    // A conflict with the graph the caller believed in, not a malformed request: the same payload
    // succeeds once the cycle is avoided or the existing parent edge is removed first.
    case 'LINK_WOULD_CYCLE':
    case 'ALREADY_HAS_PARENT':
    // Same shape: the same move succeeds once the open child resolves. Advancing is a refusal
    // (Task 13), not the exclusion `claim` uses, but it is still a conflict with the graph the
    // caller believed in, not a malformed request.
    case 'CARD_BLOCKED':
      return 409;
    // Malformed requests: too many lines, or nothing usable once stripped. The same payload will
    // never succeed unless the caller changes it, unlike the conflict codes above.
    case 'TOO_MANY_CHILDREN':
    case 'NOTHING_TO_SPLIT':
      return 400;
  }
}

/**
 * Status mapping for Task 16's advisory D1 store (`db/card-links-external.ts`, `addExternalLink`'s
 * `AddResult['code']`) — a DIFFERENT code space from `BoardErrorCode` above, used in exactly one
 * place (the `toBoardId` arm of the `…/links` route below). That is why this is a second small
 * mapping function rather than a violation of "one code, one status": the duplicate-mapping mistake
 * `statusForCode` itself once made was the SAME code (`NOT_INITIALIZED`) getting two statuses. These
 * codes are not `BoardErrorCode` at all, so there is no second status for anything already mapped.
 */
function statusForExternalLinkCode(code: string): number {
  switch (code) {
    case 'FOREIGN_BOARD':
      // The board exists but belongs to another tenant. 404, not 403 — a 403 would confirm the
      // board exists, which is a tenant-isolation leak by status code.
      return 404;
    case 'PARENT_MUST_BE_SAME_BOARD':
    case 'SELF_EDGE':
    case 'BAD_KIND':
      // The same payload can never succeed; the caller must change it.
      return 400;
    case 'SAME_BOARD_EDGE':
      // Unreachable through this route by construction — the route below sends a same-board edge
      // to the DO and never to `addExternalLink`. If this ever fires, the routing logic is broken,
      // not the caller's request, so the status says "our fault" rather than blaming them.
      return 500;
    default:
      return 500;
  }
}

/**
 * Names for the boards in `boardIds`, but ONLY the ones `tenantId` actually owns — a board id that
 * names another tenant's board, or no board at all, simply has no entry in the returned map.
 *
 * This is the read-side guard for `GET .../cards/:cardId/links`'s `otherBoardName`: a cross-board
 * advisory row's write is already checked against `FOREIGN_BOARD` (`addExternalLink`), but this
 * read must not assume every row in `card_links_external` got there through that guard — a title
 * is content, and resolving one for a board outside the tenant would disclose more than the 404
 * that guard answers with. `tenant_id = ?` first, like every other D1 read in this codebase.
 */
async function boardNamesById(db: D1Database, tenantId: string, boardIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(boardIds)];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT id, name FROM boards WHERE tenant_id = ? AND id IN (${placeholders})`)
    .bind(tenantId, ...ids)
    .all<{ id: string; name: string }>();
  return new Map((results ?? []).map((row) => [row.id, row.name]));
}

/**
 * The title of one card on another board, for one advisory edge's tooltip — or `null` if it
 * cannot be read, for any reason. This is the one place a cross-DO read happens for a cross-board
 * edge, and it is deliberately narrow: on-demand, per row, called only from the `GET .../links`
 * route, never from `listExternalLinksFor` (the D1 module stays free of cross-DO concerns) and
 * never consulted by a claim or advance decision — the read is stale the instant it returns, which
 * is exactly why the edge it labels is advisory rather than enforced, and that does not change
 * just because this read is now a little more informative than an id.
 *
 * Degrades rather than fails: an uninitialized board, a deleted card, or a thrown error (the DO
 * being genuinely unavailable) all come back `null`, wrapped PER CALL so one bad reference cannot
 * take the rest of a card's blocker list down with it — a 500 here would be a worse outcome than
 * the id the drawer already falls back to showing.
 *
 * Callers must already have confirmed `boardId` belongs to `tenantId` (see `boardNamesById`); this
 * function does not check tenancy itself, so it must never be reached for a foreign board.
 */
async function getOtherCardTitle(env: Env, tenantId: string, boardId: string, cardId: string): Promise<string | null> {
  try {
    const result = await boardStub(env, tenantId, boardId).getCardView(cardId);
    return result.ok ? result.value.title : null;
  } catch {
    return null;
  }
}

/**
 * What an error nobody planned for looks like on the wire.
 *
 * One shape, shared by every route block, so a client can read a failure the
 * same way wherever it came from. `{ error: { message } }` rather than a bare
 * string because that is what the boards routes have always answered with and
 * the web app already parses.
 */
/**
 * Refuse an act this member's role does not reach, or null to proceed.
 *
 * `memberships.role` was CHECK-constrained, written once as 'owner', and read by zero queries —
 * the whole human authorization model recorded and never consulted. This is the consultation.
 *
 * Fails closed on a null role: a person whose membership was removed still holds a valid session
 * cookie naming that tenant, and they are refused rather than demoted to a reader.
 */
function refuseByRole(user: UserPrincipal | null, capability: Capability): Response | null {
  if (!user) return Response.json({ error: 'sign in to continue' }, { status: 401 });
  if (!user.role) return Response.json({ error: 'you are not a member of this workspace' }, { status: 403 });
  if (!permits(user.role, capability)) {
    return Response.json({ error: `a ${user.role} may not do that in this workspace` }, { status: 403 });
  }
  return null;
}

/**
 * A caller on a WORKSPACE route — a person, or an agent.
 *
 * These routes (`/v1/projects`, `/v1/milestones`, `/v1/labels`, `/v1/capabilities`, `/v1/agents`)
 * resolved a human and only a human, and that was never a decision about agents: `resolveAgent` is
 * called in exactly one other place in this file, inside the board router, so an agent credential
 * never ARRIVED here to be refused. The cost was concrete — a coordinator that can queue a card
 * could not set its project, so the work fell out of every rollup and `costUsd` under-counted.
 *
 * A person is resolved first and keeps the role check they always had. Only if no human resolves is
 * an agent tried, and then the scope decides. `agentScope: null` means the route is human-only on
 * purpose, and an agent credential there is refused by name rather than with "sign in to continue",
 * which would send a thing that cannot sign in round a loop.
 */
async function resolveWorkspaceCaller(
  request: Request,
  env: Env,
  needed: {
    human: Capability;
    agentScope: AgentScope | null;
    /**
     * Which credentials count as a PERSON here.
     *
     * `'session'` means a session cookie only — the boundary `/v1/capabilities` keeps on its writes:
     * "writes fall through to `resolveUser` alone, which is the boundary this keeps." Collapsing that
     * into an unconditional hub fallback let a hub token DEFINE a capability, which its own test
     * caught. Default is `'session-or-hub'`, because `supi` carries a hub JWT and most routes are
     * meant to answer it.
     */
    humanVia?: 'session' | 'session-or-hub';
  },
): Promise<{ tenantId: string; user: UserPrincipal | null; agent: AgentPrincipal | null } | Response> {
  const user =
    (await resolveUser(request, env)) ??
    (needed.humanVia === 'session' ? null : await resolveHubUser(request, env));
  if (user) {
    const refused = refuseByRole(user, needed.human);
    if (refused) return refused;
    return { tenantId: user.tenantId, user, agent: null };
  }

  const agent = (await resolveAgent(request, env)) ?? (await resolveHubAgent(request, env));
  if (!agent) return Response.json({ error: 'sign in to continue' }, { status: 401 });
  if (needed.agentScope === null) {
    return Response.json(
      { error: 'this is not something an agent may do in this workspace' },
      { status: 403 },
    );
  }
  if (!scopePermits(agent.scopes, needed.agentScope)) {
    return Response.json(
      { error: `this token is not permitted to ${needed.agentScope}` },
      { status: 403 },
    );
  }
  return { tenantId: agent.tenantId, user: null, agent };
}

/** Would changing or removing this member leave the workspace with no owner at all? */
async function isLastOwner(db: D1Database, tenantId: string, userId: string): Promise<boolean> {
  const members = await listMembers(db, tenantId);
  const target = members.find((m) => m.userId === userId);
  if (!target || target.role !== 'owner') return false;
  return (await ownerCount(db, tenantId)) <= 1;
}

/**
 * Register every capability this pipeline names, as `inferred`.
 *
 * The declaring half of the registry's asymmetry: a stage naming `code-review` is a workspace
 * saying it needs code review done, so the capability comes into existence. An agent claiming one
 * must reference something that already exists (see the `/v1/agents` routes) — because an agent
 * holding a capability no stage names is the exact failure that matched nothing and said nothing.
 */
async function registerStageCapabilities(
  env: Env,
  tenantId: string,
  stages: StageDef[],
  createdBy: string | null,
): Promise<void> {
  // Every capability a stage mentions, however it mentions it — `owner`, or either arm of
  // `requires`. Reading only `owner` would leave a set-valued lane's capabilities unregistered,
  // so they would route correctly and be invisible to the registry that exists to explain them.
  const keys = stages
    .filter((s) => s.ownerKind === 'capability')
    .flatMap((s) => stageRequiredCapabilities(s));
  if (keys.length > 0) await ensureCapabilities(env.DB, tenantId, keys, createdBy);
}

function unexpected(err: unknown): Response {
  const message = (err as { message?: string })?.message ?? 'unexpected error';
  return Response.json({ error: { message } }, { status: 500 });
}

/**
 * GET /v1/boards/:id/runs/:runId/evidence — a SERVICE principal (superwitness) reading a run
 * (contract C4). Not an agent route and not a human route: neither kind may read it, and a
 * service may read nothing else. The tenant comes from the token's mapped fleet, so a board in
 * another tenant is simply not found.
 */
async function runEvidence(request: Request, env: Env, boardId: string, runId: string): Promise<Response> {
  const service = await resolveHubService(request, env);
  if (!service) {
    return Response.json(
      { error: { code: 'UNAUTHORIZED', message: 'a hub-issued service token for a mapped fleet is required' } },
      { status: 401 },
    );
  }
  if (!service.scopes.includes(EVIDENCE_READ)) {
    return Response.json(
      { error: { code: 'FORBIDDEN', message: 'this principal does not hold evidence:read' } },
      { status: 403 },
    );
  }
  try {
    const result = await boardStub(env, service.tenantId, boardId).getRunEvidence(runId);
    if (result.ok) {
      const ev = result.value;
      const ids = await principalIdsFor(env.DB, service.tenantId, [
        ev.run.agent_id,
        ...ev.gates.flatMap((g) => [g.produced_by, g.decided_by]),
      ]);
      const subs = await hubSubjectsFor(env.DB, ev.gates.map((g) => g.decided_by));
      const prn = (local: string | null) => (local ? ids.get(local) ?? null : null);
      return Response.json({
        ...ev,
        run: { ...ev.run, agent_principal_id: prn(ev.run.agent_id) },
        gates: ev.gates.map((g) => {
          const decidedBy = prn(g.decided_by);
          return {
            ...g,
            produced_by_principal_id: prn(g.produced_by),
            decided_by_principal_id: decidedBy,
            // Only when there is no principal id: one way to name the judge, never two.
            decided_by_hub_sub: decidedBy === null && g.decided_by ? subs.get(g.decided_by) ?? null : null,
          };
        }),
      });
    }
    if (result.code === 'NOT_INITIALIZED') return Response.json({ error: { code: 'BOARD_NOT_FOUND' } }, { status: 404 });
    if (result.code === 'RUN_NOT_FOUND') return Response.json({ error: { code: 'RUN_NOT_FOUND' } }, { status: 404 });
    return Response.json({ error: { code: result.code } }, { status: statusForCode(result.code) });
  } catch (err) {
    return unexpected(err);
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/health') {
      return Response.json({ ok: true, service: 'superpipeline-api', phase: 'P8' });
    }

    // Contract §2: a plane token whose `ent` lacks superpipeline is told so, by name, before any
    // route can turn it into a generic 401/403. Inert unless ORG_PLANE_ISSUER is set.
    const notEnabled = await entitlementRefusal(request, env);
    if (notEnabled) return notEnabled;

    // Organization-plane sign-in owns /auth/login, /auth/callback, /auth/logout and /hub/{token,
    // connect,callback} once ORG_PLANE_ISSUER is set; it answers null otherwise, and the GitHub and
    // hub-handoff routes below run exactly as before.
    if (path.startsWith('/auth/') || path.startsWith('/hub/')) {
      const res = await handlePlaneSignInRoute(request, env, path);
      if (res) return res;
    }

    // Human auth (GitHub OAuth → session): /auth/login · /auth/callback · /auth/me · /auth/logout.
    if (path.startsWith('/auth/')) {
      const res = await handleAuthRoute(request, env, path);
      if (res) return res;
    }

    // The hub token handoff: /hub/connect · /hub/callback · /hub/token (auth/hub-oauth.ts).
    //
    // Not part of `/auth/*` above, deliberately. Those routes establish who you are HERE — a
    // superpipeline session, from GitHub. These carry authority from somewhere else: the hub is the
    // issuer, superpipeline is not, and nothing under this prefix creates or reads a superpipeline session.
    // The separate prefix is also what `run_worker_first` in wrangler.jsonc names, so the SPA's
    // index.html fallback cannot shadow a callback the hub redirected a browser to.
    if (path.startsWith('/hub/')) {
      const res = await handleHubRoute(request, env, path);
      if (res) return res;
    }

    // MCP surface (docs/05 §2): an OAuth Resource Server in front of the Streamable HTTP endpoint.
    if (request.method === 'GET' && path.startsWith(MCP_PROTECTED_RESOURCE_PATH)) {
      const meta = protectedResourceMetadata(request, env, path);
      if (meta) return meta;
    }
    if (path === '/mcp') {
      const auth = await resolveMcpAuth(request, env);
      if (!auth) return unauthorized(request, env);
      return handleMcpRequest(request, env, auth);
    }

    // PATCH /v1/tenant — link this workspace to a hub fleet, or unlink it.
    //
    // The whole-branch review's Important: `setTenantExternalMapping` had NO production caller,
    // only tests — the fifth column in this programme with none — while BOTH `resolveHubUser` and
    // `resolveHubAgent` require `findTenantByExternal(db, 'agentpod', claims.tenant)` to resolve
    // before a hub credential can do anything here. So the row existed only where somebody had
    // made it by hand, which is the "no SQL at any point" rule broken at the exact seam between
    // the two repositories. This is that writer.
    //
    // Shaped as the deliberate mirror of `PATCH /v1/agents/:id` below, because it is the same act
    // one plane up: `{ externalId: "fleet_…" }` to link, `{ externalId: null }` to unlink, the
    // source hardcoded rather than accepted from the body.
    //
    // **Human-only, and not merely by convention.** `u` comes from `resolveUser` alone — session
    // cookie or dev headers, never a `spa_` bearer and never a hub token. Linking a plane is at
    // least as consequential as revoking a credential (charter
    // decisions/2026-08-13-ecosystem-identity.md Decision 3), and the hub-token path could not
    // work here anyway: `resolveHubUser` needs this mapping to already exist, so a token can
    // never establish the mapping that makes that token resolve. It is human-only or it is
    // unreachable.
    //
    // Scoped to owners. The comment this replaces recorded the absence of that check as "a
    // decision about the whole product rather than about this endpoint" — the decision is now
    // made, in db/members.ts, and every route reads it from the same place.
    /**
     * GET|PUT /v1/tenant/forge — where this workspace's forge lives.
     *
     * Deliberately NOT part of `PATCH /v1/tenant`, which is human-only because a hub token cannot
     * establish the very mapping that makes a hub token resolve — a bootstrap problem this has
     * none of. Hanging the forge host there made it unreachable from `supi`, which authenticates
     * with exactly that kind of token: the setting existed and the only client that would set it
     * got a 401.
     *
     * `manage`, not `own`. Linking a plane is an owner's act; saying which host is the forge is
     * ordinary workspace configuration, and it changes how references are read rather than who
     * this workspace answers to.
     */
    if (path === '/v1/tenant/forge') {
      const u = (await resolveUser(request, env)) ?? (await resolveHubUser(request, env));
      if (!u) return Response.json({ error: 'sign in to continue' }, { status: 401 });

      if (request.method === 'GET') {
        const refused = refuseByRole(u, 'read');
        if (refused) return refused;
        const tenant = await tenantById(env.DB, u.tenantId);
        return Response.json({ forgeHost: tenant?.forgeHost ?? null });
      }
      if (request.method !== 'PUT') return Response.json({ error: 'method not allowed' }, { status: 405 });
      {
        const refused = refuseByRole(u, 'manage');
        if (refused) return refused;
      }
      const body = (await request.json().catch(() => null)) as { forgeHost?: string | null } | null;
      if (!body || body.forgeHost === undefined) {
        return Response.json(
          { error: 'forgeHost is required (a host like `forge.example.com`, or null to clear)' },
          { status: 400 },
        );
      }
      try {
        await setTenantForgeHost(env.DB, u.tenantId, body.forgeHost);
      } catch {
        return Response.json(
          { error: 'forgeHost must be a host — `forge.example.com`, not a URL with a path' },
          { status: 400 },
        );
      }
      return Response.json({ forgeHost: body.forgeHost });
    }

    if (path === '/v1/tenant') {
      try {
        const u = await resolveUser(request, env);
        if (!u) return Response.json({ error: 'sign in to continue' }, { status: 401 });

        if (request.method === 'GET') {
          const tenant = await tenantById(env.DB, u.tenantId);
          if (!tenant) return Response.json({ error: 'workspace not found' }, { status: 404 });
          return Response.json({ tenant });
        }
        if (request.method !== 'PATCH') return Response.json({ error: 'method not allowed' }, { status: 405 });
        // In plane mode this workspace IS an org-plane mapping; writing a fleet over it would
        // orphan it, and the next token would create a fresh tenant by first sight.
        if (orgPlaneMode(env).kind !== 'off') {
          return Response.json({ error: 'this workspace is managed by the organization plane' }, { status: 409 });
        }
        // Linking a plane is at least as consequential as revoking a credential, so it is the one
        // act reserved to an owner. The comment this replaces recorded the absence of exactly this
        // check as "a decision about the whole product rather than about this endpoint" — the
        // decision is now made, in db/members.ts, and every route reads it from the same place.
        {
          const refused = refuseByRole(u, 'own');
          if (refused) return refused;
        }

        const body = (await request.json()) as { externalId?: string | null };
        if (body.externalId === undefined) {
          return Response.json({ error: 'externalId is required (a fleet_… string, or null to unlink)' }, { status: 400 });
        }
        if (body.externalId === null) {
          await setTenantExternalMapping(env.DB, u.tenantId, null);
          return Response.json({ ok: true });
        }
        // Validated here, not left to the CHECK constraint or a downstream join, for the reason
        // the agent route gives: a typo becomes a 400 that names the mistake rather than a
        // mapping that silently matches nothing. `fleet_` + 20 hex is the hub's own TenantId
        // shape (apps/hub db/schema/tenants.ts).
        if (!/^fleet_[0-9a-f]{20}$/.test(body.externalId)) {
          return Response.json({ error: 'externalId must look like fleet_ followed by 20 lowercase hex characters' }, { status: 400 });
        }
        // **No uniqueness check here, and no unique index behind it — deliberately, and not by
        // omission.** The obvious mirror of the agent route would 409 when another workspace
        // already claims this fleet, and migration 0005 was written to enforce it before
        // migration 0002's own comment settled the question the other way: "Deliberately NOT
        // unique. superpipeline is one-tenant-per-user, so two people in the same real organisation
        // legitimately map two local boundaries onto one external id. A shared mapping must
        // never become a shared keyspace: isolation stays local, on tenant_id."
        // `test/tenant-external-mapping.test.ts` asserts exactly that. A fix wave is not the
        // place to reverse a documented decision, so the mapping stays many-to-one.
        //
        // That leaves a REAL residual, recorded rather than quietly patched: under a shared
        // mapping, `findTenantByExternal` runs `.first()` with no `ORDER BY`, so a hub credential
        // for a shared fleet lands in an ARBITRARY one of the sharing workspaces —
        // `resolveHubUser` admits into it, and `resolveHubAgent` fails closed unpredictably when
        // the agent's own row sits in the other. That ambiguity predates this route and is a
        // question about whether hub-token resolution is well-defined under a many-to-one
        // mapping at all, which is a decision above this endpoint.
        await setTenantExternalMapping(env.DB, u.tenantId, { externalId: body.externalId, externalSource: 'agentpod' });
        return Response.json({ ok: true });
      } catch (err) {
        return unexpected(err);
      }
    }

    // /v1/members[/:userId] — who is in this workspace, and what they may do.
    //
    // `memberships.role` has been CHECK-constrained to owner/admin/member/viewer since migration
    // 0001, written exactly once as 'owner' by `ensurePersonalWorkspace`, and read by zero
    // queries — so a workspace was permanently one person and the four roles described nothing.
    // These are the routes that make it a real model.
    //
    // No mail is sent and none is needed: `users` is keyed on the email GitHub gives at sign-in,
    // so recording the membership first means the invitee signs in and finds the workspace
    // waiting (`primaryTenant` orders by `created_at`, so a membership made before their personal
    // workspace exists is the one they land in).
    const membersMatch = path.match(/^\/v1\/members(?:\/([^/]+))?$/);
    if (membersMatch) {
      try {
        const u = await resolveUser(request, env);
        if (!u) return Response.json({ error: 'sign in to continue' }, { status: 401 });
        const targetUserId = membersMatch[1];

        if (request.method === 'GET' && !targetUserId) {
          // Reading the roster is not an administrative act — a member needs to know who else can
          // see their board, and who to ask when they cannot do something.
          const refused = refuseByRole(u, 'read');
          if (refused) return refused;
          return Response.json({ members: await listMembers(env.DB, u.tenantId) });
        }

        // Everything below changes who may act in this workspace, which is an owner's decision.
        const refused = refuseByRole(u, 'own');
        if (refused) return refused;

        if (request.method === 'POST' && !targetUserId) {
          const body = (await request.json()) as { email?: string; role?: string; name?: string };
          const email = (body.email ?? '').trim();
          // Validated here so a typo is a sentence rather than a membership nobody can ever use:
          // the row is keyed on this address matching what GitHub returns at sign-in.
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return Response.json({ error: 'a valid email address is required' }, { status: 400 });
          }
          const role = asRole(body.role ?? 'member');
          if (!role) return Response.json({ error: 'role must be one of owner, admin, member, viewer' }, { status: 400 });
          return Response.json({ member: await addMember(env.DB, u.tenantId, { email, role, name: body.name ?? null }) }, { status: 201 });
        }

        if (targetUserId && request.method === 'PATCH') {
          const body = (await request.json()) as { role?: string };
          const role = asRole(body.role);
          if (!role) return Response.json({ error: 'role must be one of owner, admin, member, viewer' }, { status: 400 });
          // A workspace with no owner cannot be administered by anyone, including to appoint a
          // new one — it is unrecoverable through the product. So the last owner cannot step
          // down; they appoint a second owner first.
          if (role !== 'owner' && (await isLastOwner(env.DB, u.tenantId, targetUserId))) {
            return Response.json({ error: 'this is the workspace\'s only owner — appoint another before changing this' }, { status: 409 });
          }
          if (!(await setMemberRole(env.DB, u.tenantId, targetUserId, role))) {
            return Response.json({ error: 'not a member of this workspace' }, { status: 404 });
          }
          return Response.json({ ok: true });
        }

        if (targetUserId && request.method === 'DELETE') {
          if (await isLastOwner(env.DB, u.tenantId, targetUserId)) {
            return Response.json({ error: 'this is the workspace\'s only owner — appoint another before removing this one' }, { status: 409 });
          }
          if (!(await removeMember(env.DB, u.tenantId, targetUserId))) {
            return Response.json({ error: 'not a member of this workspace' }, { status: 404 });
          }
          return new Response(null, { status: 204 });
        }

        return Response.json({ error: 'method not allowed' }, { status: 405 });
      } catch (err) {
        return unexpected(err);
      }
    }

    // /v1/capabilities[/:id] — the capability registry (migration 0006).
    //
    // A capability used to be a free string on both sides of an equality test, with nothing
    // defining the set, so five producers each invented a vocabulary and almost nothing matched.
    // These routes give a capability an identity and a definition.
    //
    // They deliberately do NOT enumerate what may exist: four of the five reference agent
    // registries (MCP, A2A, Entra, NANDA) decline to define a vocabulary and standardise the
    // record instead, and a closed list here would be a migration every time somebody adds a
    // stage. The rows are shaped as A2A `AgentSkill` so a future AgentCard is a projection.
    // /v1/capabilities/implications — what one capability implies about another (migration 0007).
    //
    // Matched BEFORE `/v1/capabilities/:id`, or "implications" would be read as a capability id.
    //
    // Routing stays exact string equality; this is how a workspace says `code-review` is a kind of
    // `code` without making the match fuzzy. An agent's DECLARED set is what an operator typed;
    // its EFFECTIVE set is the closure over these edges, and only the latter is matched at claim.
    if (path === '/v1/capabilities/implications') {
      try {
        // A hub token may READ, exactly as `GET /v1/agents` already allows. The edges are half the
        // routing diagnosis — a declared set that reaches a lane only through an implication looks
        // like a mismatch until they are visible — and a terminal could not see them at all.
        // Writes fall through to `resolveUser` alone, below, which is the boundary this keeps.
        let u = await resolveUser(request, env);
        if (!u && request.method === 'GET') u = await resolveHubUser(request, env);
        if (!u) return Response.json({ error: 'sign in to continue' }, { status: 401 });

        if (request.method === 'GET') {
          const refused = refuseByRole(u, 'read');
          if (refused) return refused;
          return Response.json({ implications: await listImplications(env.DB, u.tenantId) });
        }

        // Declaring what a capability means is the same class of act as defining one.
        const refused = refuseByRole(u, 'manage');
        if (refused) return refused;

        if (request.method === 'POST') {
          const body = (await request.json()) as { from?: string; to?: string };
          const res = await addImplication(env.DB, u.tenantId, body.from ?? '', body.to ?? '', u.userId);
          if (!res.ok) {
            const message =
              res.code === 'SELF_IMPLICATION'
                ? 'a capability already implies itself; an edge to itself says nothing'
                : 'both from and to are required, and must contain a letter or a digit';
            return Response.json({ error: message }, { status: 400 });
          }
          // Both sides are registered, so an edge cannot name a capability the registry has never
          // heard of — which would show up later as an effective set nothing can explain.
          await ensureCapabilities(env.DB, u.tenantId, capabilityTags([body.from!, body.to!]), u.userId);
          return Response.json({ implications: await listImplications(env.DB, u.tenantId) }, { status: 201 });
        }

        if (request.method === 'DELETE') {
          const url = new URL(request.url);
          const from = url.searchParams.get('from') ?? '';
          const to = url.searchParams.get('to') ?? '';
          if (!(await removeImplication(env.DB, u.tenantId, from, to))) {
            return Response.json({ error: 'no such implication' }, { status: 404 });
          }
          return new Response(null, { status: 204 });
        }

        return Response.json({ error: 'method not allowed' }, { status: 405 });
      } catch (err) {
        return unexpected(err);
      }
    }

    const capsMatch = path.match(/^\/v1\/capabilities(?:\/([^/]+))?$/);
    if (capsMatch) {
      try {
        // A hub token may READ the registry — "anyone who can see the board needs to know what its
        // lanes ask for", and that included nobody at a terminal. Defining the vocabulary stays
        // session-only: it is "the same class of act as managing its agents", which is human-only
        // on purpose, so the fallback is scoped to GET and nothing below it changes.
        // Reads open to an agent: routing is exact string equality between a stage's owner and an
        // agent's capabilities, so this is HALF the diagnosis of a card that will not move. Declaring
        // the vocabulary stays a person's act, which the route's own comment already argued.
        const caller = await resolveWorkspaceCaller(request, env, {
          human: request.method === 'GET' ? 'read' : 'manage',
          agentScope: request.method === 'GET' ? 'read' : null,
          // Writes stay session-only, which is the boundary this route already kept.
          humanVia: request.method === 'GET' ? 'session-or-hub' : 'session',
        });
        if (caller instanceof Response) return caller;
        const { tenantId: wsTenantId, user: u } = caller;
        const capId = capsMatch[1];

        if (request.method === 'GET' && !capId) {
          // A read: anyone who can see the board needs to know what its lanes ask for.
          return Response.json({ capabilities: await listCapabilities(env.DB, wsTenantId) });
        }

        // Defining the workspace's vocabulary is the same class of act as managing its agents.

        if (request.method === 'POST' && !capId) {
          const body = (await request.json()) as {
            key?: string;
            name?: string;
            description?: string | null;
            tags?: string[];
            examples?: string[];
            externalId?: string | null;
            externalSource?: string | null;
          };
          if (!body.key || capabilityTag(body.key) === '') {
            return Response.json({ error: 'key is required, and must contain a letter or a digit' }, { status: 400 });
          }
          // Existing keys that look like the one being created, computed BEFORE the write so the
          // candidate does not match itself. A hint on the response, never a refusal: only a
          // person knows whether `cdoe` was a typo for `code` or a word they meant.
          const existing = (await listCapabilities(env.DB, wsTenantId)).map((c) => c.key);
          const similar = similarKeys(body.key, existing);

          // Built from named fields rather than `{ ...body, key: body.key, createdBy: u.userId }`:
          // `createdBy` already won that field (it was placed after the spread), but the cast
          // above does not stop a body from carrying other keys `createCapability` happens to
          // read — safe today only because its input type coincides with this one.
          const made = await createCapability(env.DB, wsTenantId, {
            key: body.key,
            name: body.name,
            description: body.description,
            tags: body.tags,
            examples: body.examples,
            externalId: body.externalId,
            externalSource: body.externalSource,
            // `u?.`, not `u!.`: the helper above refuses an agent on every non-GET here, so this is
            // always a person — but the guarantee lives in that call's arguments rather than in the
            // type, and `created_by` is nullable precisely so a caller without a user id is
            // representable. Same shape `registerStageCapabilities` already uses.
            createdBy: u?.userId ?? null,
          });
          if (!made) {
            // A collision reads as a sentence rather than a raw UNIQUE failure — and re-declaring
            // an existing capability is a rename, which `PATCH` does.
            return Response.json({ error: `${capabilityTag(body.key)} already exists in this workspace` }, { status: 409 });
          }
          return Response.json(similar.length > 0 ? { capability: made, similar } : { capability: made }, {
            status: 201,
          });
        }

        if (capId && request.method === 'PATCH') {
          const body = (await request.json()) as {
            name?: string;
            description?: string | null;
            tags?: string[];
            examples?: string[];
            externalId?: string | null;
            externalSource?: string | null;
          };
          // `key` is absent by design: stages and agents carry it, so renaming it in place would
          // orphan every one of them silently — the identical reason a stage key cannot be renamed.
          if ('key' in body) {
            return Response.json({ error: 'a capability key cannot be renamed — stages and agents refer to it. Create another and restaff.' }, { status: 400 });
          }
          // Built from named fields rather than forwarding `body` whole: the cast above strips
          // nothing at runtime, so the route has to name what `updateCapability` accepts.
          if (
            !(await updateCapability(env.DB, wsTenantId, capId, {
              name: body.name,
              description: body.description,
              tags: body.tags,
              examples: body.examples,
              externalId: body.externalId,
              externalSource: body.externalSource,
            }))
          ) {
            return Response.json({ error: 'capability not found, or nothing to change' }, { status: 404 });
          }
          return Response.json({ capability: await capabilityById(env.DB, wsTenantId, capId) });
        }

        if (capId && request.method === 'DELETE') {
          const cap = await capabilityById(env.DB, wsTenantId, capId);
          if (!cap) return Response.json({ error: 'capability not found' }, { status: 404 });
          // Removing one that is still named would silently stop the registry describing the
          // product: the strings stay on the stage and the agent, matching carries on, and the
          // list quietly goes wrong. So the refusal names who still refers to it.
          const used = await capabilityUsage(env.DB, wsTenantId, cap.key);
          if (used.agents.length > 0 || used.boards.length > 0 || used.implications.length > 0) {
            const who = [
              used.boards.length > 0 ? `boards ${used.boards.join(', ')}` : null,
              used.agents.length > 0 ? `agents ${used.agents.join(', ')}` : null,
              // An edge refers to it too. Deleting one end would leave an agent's effective set
              // containing a capability the registry can no longer explain.
              used.implications.length > 0 ? `implications ${used.implications.join(', ')}` : null,
            ].filter(Boolean).join(' and ');
            return Response.json({ error: `${cap.key} is still used by ${who}`, usage: used }, { status: 409 });
          }
          await deleteCapability(env.DB, wsTenantId, capId);
          return new Response(null, { status: 204 });
        }

        return Response.json({ error: 'method not allowed' }, { status: 405 });
      } catch (err) {
        return unexpected(err);
      }
    }

    // /v1/labels[/:id] — the tenant's label catalogue (migration 0010).
    //
    // `Card.labels` has named this since the contract's Card schema existed, with no table and no
    // route behind it (docs/01). The catalogue is tenant-scoped, not board-scoped, because a label
    // that means one thing on one board and another on a second is not a label. What a card carries
    // is validated and stored separately, on the `PATCH /v1/boards/:id/cards/:cardId` route below.
    const labelsMatch = path.match(/^\/v1\/labels(?:\/([^/]+))?$/);
    if (labelsMatch) {
      try {
        // The CLI's `supi label list|add|rm` send a hub JWT (Authorization: Bearer), never a
        // session cookie — `resolveUser` alone can't read it. Unconditional on method, unlike the
        // GET-only fallback on `/v1/capabilities`: those verbs are CLI-reachable too, and
        // `refuseByRole(u, 'manage')` below is what actually gates the writes, exactly as it
        // already gates a session-authenticated write.
        // A person, or an agent READING the catalogue — a card's labels are ids until something resolves
        // them, and an agent that cannot read them cannot report what a card is. Writing the
        // catalogue stays a person's.
        const caller = await resolveWorkspaceCaller(request, env, {
          human: request.method === 'GET' ? 'read' : 'manage',
          agentScope: request.method === 'GET' ? 'read' : null,
        });
        if (caller instanceof Response) return caller;
        const { tenantId: wsTenantId, user: u } = caller;
        const labelId = labelsMatch[1];

        if (request.method === 'GET' && !labelId) {
          return Response.json({ labels: await listLabels(env.DB, wsTenantId) });
        }

        // Defining the workspace's labels is the same class of act as managing its capabilities.

        if (request.method === 'POST' && !labelId) {
          const body = (await request.json()) as { name?: string; colour?: string };
          const name = body.name?.trim() ?? '';
          if (name === '') {
            return Response.json({ error: 'name is required' }, { status: 400 });
          }
          if (!body.colour || body.colour.trim() === '') {
            return Response.json({ error: 'colour is required' }, { status: 400 });
          }
          try {
            const made = await createLabel(env.DB, wsTenantId, { name, colour: body.colour });
            return Response.json({ label: made }, { status: 201 });
          } catch (err) {
            // Narrowed to the exact UNIQUE(tenant_id, name) collision — anything else (a transient
            // D1 error, whatever) rethrows to the outer `unexpected(err)` handler rather than being
            // mislabelled as a name collision and having the real error discarded.
            if (!isLabelNameCollision(err)) throw err;
            // Read as a sentence rather than a raw SQLite constraint error, and against the
            // trimmed name actually attempted — the same treatment `/v1/capabilities` gives its
            // own collision.
            return Response.json({ error: `a label named "${name}" already exists in this workspace` }, { status: 409 });
          }
        }

        if (labelId && request.method === 'PATCH') {
          const body = (await request.json()) as { name?: string; colour?: string };
          // Same type guard as POST: a non-string or empty `name` must not reach `.trim()` in
          // `db/labels.ts` (a bare throw there, caught by neither branch below) or `updateLabel`'s
          // own `throw` on an empty trimmed name — both currently 500 instead of 400.
          if (body.name !== undefined) {
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (name === '') {
              return Response.json({ error: 'name is required' }, { status: 400 });
            }
          }
          try {
            // Built from named fields rather than forwarding `body` whole, same as the capability
            // PATCH above: the cast strips nothing at runtime.
            const updated = await updateLabel(env.DB, wsTenantId, labelId, { name: body.name, colour: body.colour });
            if (!updated) return Response.json({ error: 'label not found' }, { status: 404 });
            return Response.json({ label: updated });
          } catch (err) {
            // Same narrowed collision catch as POST — renaming onto an existing name (including a
            // case variant, which migration 0011's index makes collide) is a clean 409, not a raw
            // constraint failure surfaced as a 500.
            if (!isLabelNameCollision(err)) throw err;
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            return Response.json({ error: `a label named "${name}" already exists in this workspace` }, { status: 409 });
          }
        }

        if (labelId && request.method === 'DELETE') {
          if (!(await deleteLabel(env.DB, wsTenantId, labelId))) {
            return Response.json({ error: 'label not found' }, { status: 404 });
          }
          return new Response(null, { status: 204 });
        }

        return Response.json({ error: 'method not allowed' }, { status: 405 });
      } catch (err) {
        return unexpected(err);
      }
    }

    /**
     * POST /v1/admin/superwitness/backfill — enqueue a superwitness report for every run on one
     * board (superwitness app spec §3.5; ruling R18). Idempotent, and the repair tool for parked or
     * missed reports.
     *
     * A person with `manage` (admin or owner) in the board's workspace. Not an agent: re-reporting a
     * board's history is administration, not shaping work. 409 while reporting is off, because an
     * off reporter writes no outbox rows and a 200 would claim work that did not happen.
     */
    if (path === '/v1/admin/superwitness/backfill') {
      if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
      const caller = await resolveWorkspaceCaller(request, env, { human: 'manage', agentScope: null });
      if (caller instanceof Response) return caller;
      let body: { board_id?: unknown } | null = null;
      try {
        body = (await request.json()) as { board_id?: unknown };
      } catch {
        body = null;
      }
      const boardId = typeof body?.board_id === 'string' ? body.board_id.trim() : '';
      if (boardId === '') return Response.json({ error: 'board_id is required' }, { status: 400 });
      if (!reportingEnabled(env)) {
        return Response.json({ error: 'run reporting is off: SUPERWITNESS_URL is not set' }, { status: 409 });
      }
      const boards = await listBoards(env.DB, caller.tenantId);
      if (!boards.some((b) => b.id === boardId)) return Response.json({ error: 'board not found' }, { status: 404 });
      const result = await boardStub(env, caller.tenantId, boardId).enqueueAllRunReports();
      if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
      return Response.json({ board_id: boardId, ...result.value });
    }

    // /v1/projects[/:id[/milestones|/rollup]] — a workspace's projects (migration 0013), which
    // group cards ACROSS boards. `GET /v1/projects/:id/rollup` (Task 19) is the one read in this
    // module that fans out to every board's Durable Object, via `computeRollup` (`db/projects.ts`)
    // — nothing else here touches a board.
    const projectsMatch = path.match(/^\/v1\/projects(?:\/([^/]+)(?:\/(milestones|rollup))?)?$/);
    if (projectsMatch) {
      try {
        /**
         * A person, or a coordinator agent.
         *
         * `supi project ...` sends a hub JWT and never a session cookie, so `resolveUser` alone
         * cannot authenticate a person here — that fallback is unchanged. What is new is the agent:
         * reading a project is `read`, and creating or editing one is `plan`. DELETE stays a
         * person's, because a project is a record and removing one is not shaping work.
         *
         * The role check for a human is identical to before; it has simply moved into the helper.
         */
        const caller = await resolveWorkspaceCaller(request, env, {
          human: request.method === 'GET' ? 'read' : 'manage',
          agentScope:
            request.method === 'GET' ? 'read' : request.method === 'DELETE' ? null : 'plan',
        });
        if (caller instanceof Response) return caller;
        const { tenantId: wsTenantId, user: u } = caller;
        const projectId = projectsMatch[1];
        const subSeg = projectsMatch[2];

        if (request.method === 'GET' && !projectId) {
          return Response.json({ projects: await listProjects(env.DB, wsTenantId) });
        }

        if (request.method === 'GET' && projectId && subSeg === 'rollup') {
          // Same cross-tenant-reads-as-404 reasoning as the project read just below.
          if (!(await projectById(env.DB, wsTenantId, projectId))) {
            return Response.json({ error: 'project not found' }, { status: 404 });
          }
          // The cached row, reused inside 60s; recomputed (and re-cached) once it is older than
          // that. `computeRollup` is the one fan-out in this design — see its own comment in
          // `db/projects.ts` for why it is tenant-scoped and why `partial` exists at all.
          const cached = await cachedRollup(env.DB, wsTenantId, projectId);
          const STALE_MS = 60_000;
          const fresh = cached && Date.now() - new Date(cached.computedAt).getTime() < STALE_MS;
          const rollup = fresh ? cached! : await computeRollup(env.DB, env, wsTenantId, projectId);
          return Response.json({ rollup });
        }

        if (request.method === 'GET' && projectId && !subSeg) {
          const project = await projectById(env.DB, wsTenantId, projectId);
          // A cross-tenant read answers 404, not 403: a 403 confirms the row exists under some
          // tenant, which is exactly the oracle that would let a caller enumerate another
          // tenant's project ids one guess at a time. `projectById` already scopes on
          // `tenant_id`, so "not mine" and "does not exist" are indistinguishable here, which is
          // the point — they must read the same to the caller too.
          if (!project) return Response.json({ error: 'project not found' }, { status: 404 });
          const milestones = await listMilestones(env.DB, wsTenantId, projectId);
          return Response.json({ project, milestones });
        }

        // Every write below is the same class of act as managing the workspace's capabilities or
        // labels.

        if (request.method === 'POST' && !projectId) {
          const body = (await request.json()) as {
            name?: string;
            description?: string;
            targetDate?: string;
            leadUserId?: string;
          };
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (name === '') return Response.json({ error: 'name is required' }, { status: 400 });
          if (isInvalidDueAt(body.targetDate)) {
            return Response.json({ error: 'targetDate must be YYYY-MM-DD' }, { status: 400 });
          }
          try {
            const made = await createProject(env.DB, wsTenantId, {
              name,
              description: body.description ?? null,
              targetDate: body.targetDate ?? null,
              leadUserId: body.leadUserId ?? null,
            });
            return Response.json({ project: made }, { status: 201 });
          } catch (err) {
            if (!isProjectNameCollision(err)) throw err;
            return Response.json(
              { error: `a project named "${name}" already exists in this workspace` },
              { status: 409 },
            );
          }
        }

        if (request.method === 'PATCH' && projectId && !subSeg) {
          const body = (await request.json()) as {
            name?: string;
            description?: string | null;
            targetDate?: string | null;
            state?: string;
            health?: string | null;
            leadUserId?: string | null;
          };
          if (body.name !== undefined) {
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (name === '') return Response.json({ error: 'name is required' }, { status: 400 });
          }
          if (isInvalidDueAt(body.targetDate)) {
            return Response.json({ error: 'targetDate must be YYYY-MM-DD' }, { status: 400 });
          }
          if (body.state !== undefined && !PROJECT_STATES.includes(body.state as ProjectState)) {
            return Response.json({ error: `unknown project state: "${body.state}"` }, { status: 400 });
          }
          if (
            body.health !== undefined &&
            body.health !== null &&
            !PROJECT_HEALTHS.includes(body.health as ProjectHealth)
          ) {
            return Response.json({ error: `unknown project health: "${body.health}"` }, { status: 400 });
          }
          try {
            const updated = await updateProject(env.DB, wsTenantId, projectId, {
              ...(body.name !== undefined ? { name: body.name.trim() } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.targetDate !== undefined ? { targetDate: body.targetDate } : {}),
              ...(body.state !== undefined ? { state: body.state as ProjectState } : {}),
              ...(body.health !== undefined ? { health: body.health as ProjectHealth | null } : {}),
              ...(body.leadUserId !== undefined ? { leadUserId: body.leadUserId } : {}),
            });
            if (!updated) return Response.json({ error: 'project not found' }, { status: 404 });
            return Response.json({ project: updated });
          } catch (err) {
            if (!isProjectNameCollision(err)) throw err;
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            return Response.json(
              { error: `a project named "${name}" already exists in this workspace` },
              { status: 409 },
            );
          }
        }

        if (request.method === 'DELETE' && projectId && !subSeg) {
          // Unconditional, the same way `deleteLabel` is (NOT `deleteCapability`, which refuses
          // with 409 when still used — it can, because a capability's references are entirely in
          // D1 and one cheap query finds them all). A card carrying this project's (or one of its
          // milestones') id lives in a board Durable Object this route cannot and must not reach,
          // so refusing while one might exist would mean exactly the cross-DO read the spec
          // forbids on a write path. See the comment on `deleteProject` in db/projects.ts for the
          // full reasoning.
          if (!(await deleteProject(env.DB, wsTenantId, projectId))) {
            return Response.json({ error: 'project not found' }, { status: 404 });
          }
          return new Response(null, { status: 204 });
        }

        if (request.method === 'POST' && projectId && subSeg === 'milestones') {
          const body = (await request.json()) as { name?: string; targetDate?: string; sortOrder?: number };
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (name === '') return Response.json({ error: 'name is required' }, { status: 400 });
          if (isInvalidDueAt(body.targetDate)) {
            return Response.json({ error: 'targetDate must be YYYY-MM-DD' }, { status: 400 });
          }
          if (body.sortOrder !== undefined && typeof body.sortOrder !== 'number') {
            return Response.json({ error: 'sortOrder must be a number' }, { status: 400 });
          }
          // Checked here rather than caught from `createMilestone`'s own ownership throw, so an
          // unrelated failure (a transient D1 error, say) still falls through to the outer
          // `unexpected(err)` instead of being misreported as "project not found". Same 404 an
          // enumeration attempt on `GET /v1/projects/:id` would get, for the same reason.
          if (!(await projectById(env.DB, wsTenantId, projectId))) {
            return Response.json({ error: 'project not found' }, { status: 404 });
          }
          const made = await createMilestone(env.DB, wsTenantId, projectId, {
            name,
            targetDate: body.targetDate ?? null,
            sortOrder: body.sortOrder,
          });
          return Response.json({ milestone: made }, { status: 201 });
        }

        return Response.json({ error: 'method not allowed' }, { status: 405 });
      } catch (err) {
        return unexpected(err);
      }
    }

    // DELETE /v1/milestones/:id — one milestone, removed on its own without deleting its project.
    const milestoneMatch = path.match(/^\/v1\/milestones\/([^/]+)$/);
    if (milestoneMatch) {
      try {
        let u = await resolveUser(request, env);
        if (!u) u = await resolveHubUser(request, env);
        if (!u) return Response.json({ error: 'sign in to continue' }, { status: 401 });
        const refused = refuseByRole(u, 'manage');
        if (refused) return refused;

        if (request.method !== 'DELETE') return Response.json({ error: 'method not allowed' }, { status: 405 });
        if (!(await deleteMilestone(env.DB, u.tenantId, milestoneMatch[1]!))) {
          return Response.json({ error: 'milestone not found' }, { status: 404 });
        }
        return new Response(null, { status: 204 });
      } catch (err) {
        return unexpected(err);
      }
    }

    // /v1/agents[/:id[/tokens/:tokenId]] — a workspace's agents + token minting (the "connect an
    // agent" surface) + token revocation, right beside it. The plaintext token is returned ONCE
    // on create; thereafter only its hash is stored, and revoking sets `revoked_at` on that row —
    // `findAgentByTokenHash` already refuses anything revoked (catalog.ts), so this write is the
    // whole mechanism.
    // GET /v1/agents/:id/card — the agent's A2A AgentCard, projected from the registry.
    //
    // Matched before the agents block, whose regex ends at `/tokens`. This is what naming
    // migration 0006's columns after `AgentSkill` was for: the card is a projection of those rows
    // rather than a translation of them, so nothing is renamed on the way out.
    const cardMatch = path.match(/^\/v1\/agents\/([^/]+)\/card$/);
    if (cardMatch) {
      try {
        const u = await resolveUser(request, env);
        if (!u) return Response.json({ error: 'sign in to continue' }, { status: 401 });
        if (request.method !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });
        const refused = refuseByRole(u, 'read');
        if (refused) return refused;

        const agents = await listAgents(env.DB, u.tenantId);
        const found = agents.find((a) => a.id === cardMatch[1]);
        if (!found) return Response.json({ error: 'no such agent' }, { status: 404 });

        // The card shows the EFFECTIVE set: what this agent can actually be routed for. Showing
        // only the declared set would publish a card that disagrees with the claim predicate.
        const effective = await effectiveCapabilities(env.DB, u.tenantId, found.capabilities);
        const card = buildAgentCard(
          { name: found.name, capabilities: effective },
          await listCapabilities(env.DB, u.tenantId),
        );
        return Response.json({ card });
      } catch (err) {
        return unexpected(err);
      }
    }

    const agentsMatch = path.match(/^\/v1\/agents(?:\/([^/]+)(?:\/(tokens)(?:\/([^/]+))?)?)?$/);
    if (agentsMatch) {
      // Every route below is inside this, and the whole-branch review is why.
      // The only catch-all in this file wrapped `/v1/boards` alone, so an
      // unexpected error anywhere in the agents routes — a raced UNIQUE write
      // against `agents_external_pair_unique`, a malformed body, a D1 hiccup —
      // escaped the Worker's fetch handler entirely instead of becoming a
      // structured 500. Same write safety, strictly worse failure: the caller
      // got a bare Worker error with no shape a client could read. Kept out of
      // an earlier narrow fix round on purpose, because it is a property of the
      // whole route block rather than of one endpoint, and a route-wide change
      // belongs in one deliberate edit.
      try {
        // The first endpoint to accept a hub-issued token
        // (charter decisions/2026-08-15-one-issuer-and-offline-verification.md).
        //
        // Read-only, and only as a FALLBACK: the session cookie and `spa_` token
        // paths are untouched and still take precedence, so nothing that works
        // today changes. The hub token is verified offline against a cached JWKS —
        // no network call in this path — and resolves to the same principal shape,
        // so nothing downstream can tell which credential arrived.
        //
        // Deliberately not extended to POST or DELETE: a first integration should not also be the
        // first credential able to mint an agent token.
        //
        // PATCH is, and the reason above is exactly why it is safe to. That sentence is about
        // CREDENTIALS, and a PATCH mints none — it changes what an agent IS. Leaving it out had a
        // cost that showed up immediately: `supi` carries a hub token and nothing else, so the
        // queueing policy shipped with a setter the only client written for it answered 401 to,
        // while `supi agents` beside it answered 200. A permission nobody can set is the failure
        // that setter existed to fix.
        //
        // `externalId` is carved back out below. Mapping an agent to a principal is what makes an
        // agent-kind hub token resolve at all (`resolveHubAgent` finds the agent BY that mapping),
        // so a credential able to write it could point an agent row at any principal and grant
        // itself identities.
        let u = await resolveUser(request, env);
        const viaHubToken = !u;
        if (!u && (request.method === 'GET' || request.method === 'PATCH')) {
          u = await resolveHubUser(request, env);
        }
        /**
         * An AGENT may READ this list, on `read`, and nothing more.
         *
         * It is half of any routing diagnosis — a card that will not move is almost always a stage
         * asking for a capability nobody declares, and this is the side that says who declares what.
         * The row carries `tokenIds` and the queueing policy but never a token, so reading which
         * credentials exist is not holding one.
         *
         * Writes stay exactly as they were: PATCH needs a person (hub token included, since `supi`
         * carries one), and minting or revoking a credential needs a session — charter Decision 3.
         */
        let listingAgent: AgentPrincipal | null = null;
        if (!u && request.method === 'GET' && !agentsMatch[2]) {
          listingAgent = (await resolveAgent(request, env)) ?? (await resolveHubAgent(request, env));
          if (listingAgent && !scopePermits(listingAgent.scopes, 'read')) {
            return Response.json({ error: 'this token is not permitted to read' }, { status: 403 });
          }
          if (listingAgent) {
            return Response.json({ agents: await listAgents(env.DB, listingAgent.tenantId) });
          }
        }
        if (!u) return Response.json({ error: 'sign in to continue' }, { status: 401 });
        const agentId = agentsMatch[1];
        const tokenId = agentsMatch[3];
        const mintingTokens = agentId && agentsMatch[2] === 'tokens' && !tokenId;

        // POST /v1/agents/:id/tokens — issue a fresh `spa_` for an agent that already exists.
        //
        // Without this, revoking an agent's last token was terminal: tokens were only ever minted
        // inside `POST /v1/agents`, so "cannot authenticate until reconnected" named a reconnect
        // that did not exist, and a linked agent — which is created with no `spa_` at all — could
        // never be issued one even when it needed a native credential.
        //
        // Human-only, exactly like revocation: `u` came from `resolveUser` alone, so an agent can
        // never mint itself a second credential to outlive one a person revoked
        // (charter decisions/2026-08-13-ecosystem-identity.md Decision 3).
        // Everything below the agent list is workspace administration: minting and revoking
        // credentials, restaffing an agent, deleting one. `member` works the board; managing what
        // works it is `admin`.
        if (request.method !== 'GET') {
          const refused = refuseByRole(u, 'manage');
          if (refused) return refused;
        } else {
          const refused = refuseByRole(u, 'read');
          if (refused) return refused;
        }

        if (mintingTokens) {
          if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
          if (!(await agentBelongsToTenant(env.DB, u.tenantId, agentId))) {
            return Response.json({ error: 'agent not found' }, { status: 404 });
          }
          /**
           * A caller may ask for less than the default, and never for more than exists.
           *
           * Both mint sites passed `AGENT_TOKEN_SCOPES` unconditionally, so there was no way to
           * issue a credential that can finish the card it holds and cannot ask for another. That
           * narrowing is what makes direct MCP access for an agent defensible: AgentPod's prompt
           * contract objects that a harness driving the board itself "would keep a lease open past
           * the card it was claimed for", and a run-only token is the answer to it.
           *
           * Absent means the default, so every existing caller is unaffected.
           */
          const mintBody = (await request.json().catch(() => ({}))) as { scopes?: unknown };
          let scopes: AgentScope[] = AGENT_TOKEN_SCOPES;
          if (mintBody.scopes !== undefined) {
            const asked = mintBody.scopes;
            if (
              !Array.isArray(asked) ||
              asked.length === 0 ||
              !asked.every(isAgentScope)
            ) {
              return Response.json(
                { error: `scopes must be a non-empty subset of ${AGENT_TOKEN_SCOPES.join(', ')}` },
                { status: 400 },
              );
            }
            scopes = [...new Set(asked)];
          }
          const minted = await createAgentToken(env.DB, u.tenantId, agentId, scopes);
          return Response.json({ token: minted.token, tokenId: minted.id, scopes }, { status: 201 });
        }

        if (agentId && tokenId) {
          // Revoking a credential is a HUMAN act, same as minting one: `u` above came ONLY from
          // `resolveUser` (session cookie or dev headers) — never from a `spa_` bearer or a hub
          // token — so an agent can never revoke its own token, or a peer's, to escape an audit
          // (charter decisions/2026-08-13-ecosystem-identity.md Decision 3).
          if (request.method === 'DELETE') {
            await revokeAgentToken(env.DB, u.tenantId, agentId, tokenId);
            return new Response(null, { status: 204 });
          }
          return Response.json({ error: 'method not allowed' }, { status: 405 });
        }
        if (agentId) {
          if (request.method === 'DELETE') {
            await deleteAgent(env.DB, u.tenantId, agentId);
            return new Response(null, { status: 204 });
          }
          // PATCH links (or clears) this agent's suite principal (charter
          // decisions/2026-08-30-an-agent-is-a-principal.md §5): `{ externalId: "prn_…" }` to link,
          // `{ externalId: null }` to clear. `setAgentExternalMapping` has existed since an earlier
          // task with no caller — this is that caller. It is what lets `resolveHubAgent` turn an
          // agent-kind hub token into a local agent; with no mapping there is nothing for that
          // resolver to find, and NULL stays the normal state for a standalone board.
          if (request.method === 'PATCH') {
            // `setAgentExternalMapping` is itself tenant-scoped (mirroring `revokeAgentToken`) —
            // this check is what turns a cross-tenant PATCH into a 404 instead of a 200 whose write
            // silently landed nowhere.
            if (!(await agentBelongsToTenant(env.DB, u.tenantId, agentId))) {
              return Response.json({ error: 'agent not found' }, { status: 404 });
            }
            const body = (await request.json()) as {
              externalId?: string | null;
              name?: string;
              capabilities?: string[];
              iconUrl?: string | null;
              concurrency?: number;
              /** The queueing policy (migration 0015). `unknown` because both are validated below. */
              ownerUserId?: unknown;
              mayQueueTo?: unknown;
              queueCeilingPerHour?: unknown;
            };

            // The agent's OWN properties, which until now could be set exactly once — in the
            // INSERT inside `createAgent` — and changed nowhere. An agent staffed with the wrong
            // capabilities could not be restaffed; the only remedy was to delete it and make
            // another, which for a linked agent discards its principal link too.
            //
            // Handled before the externalId branch, and independently of it: linking a principal
            // and editing an agent are different acts that happen to share a route, and a PATCH
            // carrying only `capabilities` must not be refused for want of an `externalId`.
            const patch: {
              name?: string;
              capabilities?: string[];
              iconUrl?: string | null;
              concurrency?: number;
              ownerUserId?: string | null;
              mayQueueTo?: string[] | null;
              queueCeilingPerHour?: number;
            } = {};
            if (body.name !== undefined) {
              if (typeof body.name !== 'string' || body.name.trim() === '') {
                return Response.json({ error: 'name must be a non-empty string' }, { status: 400 });
              }
              patch.name = body.name.trim();
            }
            if (body.capabilities !== undefined) {
              if (!Array.isArray(body.capabilities) || body.capabilities.some((c) => typeof c !== 'string' || c.trim() === '')) {
                return Response.json({ error: 'capabilities must be an array of non-empty strings' }, { status: 400 });
              }
              // Normalised on the way in, with the SAME function that spells a stage's owner
              // (`capabilityTag`, in the contract). Routing is exact string equality, so an
              // operator typing "Code Review" must produce `code-review` — what a stage named
              // "Code Review" carries — and not `code review`, which equals nothing.
              patch.capabilities = capabilityTags(body.capabilities);
              // Registered, not refused. Refusing an unknown capability here was the first design
              // and it was wrong twice over: it dead-ends the first agent in a workspace with no
              // boards, and it only ever stops the NEXT typo — the agents already holding `claim`
              // would have sailed through. Recording it instead lets `GET /v1/capabilities` say
              // "held by 13 agents, named by no stage", which finds the bug retroactively.
              await ensureCapabilities(env.DB, u.tenantId, patch.capabilities, u.userId);
            }
            if (body.iconUrl !== undefined) {
              if (body.iconUrl !== null && !/^https:\/\//i.test(body.iconUrl)) {
                // Rendered as an <img> src in the board UI, so the scheme is checked at the write
                // boundary — the same rule `addReference` applies to a reference url.
                return Response.json({ error: 'iconUrl must be an https URL, or null to clear it' }, { status: 400 });
              }
              patch.iconUrl = body.iconUrl;
            }
            if (body.concurrency !== undefined) {
              if (!Number.isInteger(body.concurrency) || body.concurrency < 1) {
                return Response.json({ error: 'concurrency must be a whole number of at least 1' }, { status: 400 });
              }
              patch.concurrency = body.concurrency;
            }
            /**
             * What bounds this agent when it queues work of its own (migration 0015).
             *
             * Both ids are checked against this workspace rather than trusted. An owner who is not
             * a user would own real work to somebody who does not exist — the `usr_dev` failure
             * with extra steps — and an allowlist naming a board that is not here permits nothing,
             * silently, while reading as configured. Both would surface only when an agent tried to
             * queue, which is the wrong end of the system to learn about a typo.
             */
            if ('ownerUserId' in body) {
              if (body.ownerUserId !== null) {
                if (typeof body.ownerUserId !== 'string' || body.ownerUserId.trim() === '') {
                  return Response.json({ error: 'ownerUserId must be a user id, or null to clear it' }, { status: 400 });
                }
                if (!(await mayOwnWork(env.DB, u.tenantId, body.ownerUserId))) {
                  return Response.json(
                    { error: `${body.ownerUserId} is not a user in this workspace` },
                    { status: 400 },
                  );
                }
              }
              patch.ownerUserId = body.ownerUserId as string | null;
            }
            if ('mayQueueTo' in body) {
              if (body.mayQueueTo !== null) {
                if (!Array.isArray(body.mayQueueTo) || body.mayQueueTo.some((b) => typeof b !== 'string' || b.trim() === '')) {
                  return Response.json(
                    { error: 'mayQueueTo must be an array of board ids, [] for none, or null to clear it' },
                    { status: 400 },
                  );
                }
                const known = new Set((await listBoards(env.DB, u.tenantId)).map((b) => b.id));
                const unknown = (body.mayQueueTo as string[]).filter((b) => !known.has(b));
                if (unknown.length > 0) {
                  return Response.json(
                    { error: `not a board in this workspace: ${unknown.join(', ')}` },
                    { status: 400 },
                  );
                }
              }
              patch.mayQueueTo = body.mayQueueTo as string[] | null;
            }
            if (body.queueCeilingPerHour !== undefined) {
              const ceiling = body.queueCeilingPerHour;
              if (typeof ceiling !== 'number' || !Number.isInteger(ceiling) || ceiling < 1) {
                // Zero would be an agent that holds the scope and silently cannot use it. If that
                // is what the operator means, `mayQueueTo: []` is where they say so.
                return Response.json({ error: 'queueCeilingPerHour must be a whole number of at least 1' }, { status: 400 });
              }
              patch.queueCeilingPerHour = ceiling;
            }
            if (Object.keys(patch).length > 0) await updateAgent(env.DB, u.tenantId, agentId, patch);

            if (body.externalId !== undefined && viaHubToken) {
              // The one field a hub token may not write, and the refusal is explicit rather than a
              // silent drop: a caller that asked to link a principal and got `{ok:true}` would
              // believe it had.
              return Response.json(
                {
                  error:
                    'externalId cannot be set with a hub token — mapping an agent to a principal is what makes an agent token resolve, so it is a session-only act',
                },
                { status: 403 },
              );
            }
            if (body.externalId === undefined) {
              // A patch that only touched the agent's own fields is complete. Only a request that
              // named NOTHING at all is a mistake worth reporting.
              if (Object.keys(patch).length > 0) return Response.json({ ok: true });
              return Response.json(
                {
                  error:
                    'nothing to change: send name, capabilities, iconUrl, concurrency, ownerUserId, mayQueueTo, queueCeilingPerHour, or externalId',
                },
                { status: 400 },
              );
            }
            if (body.externalId === null) {
              await setAgentExternalMapping(env.DB, u.tenantId, agentId, null);
              return Response.json({ ok: true });
            }
            // Caught here, not left to the CHECK constraint or a downstream join: a typo becomes a
            // 400 that names the mistake, not a mapping that silently matches nothing.
            if (!/^prn_[0-9a-f]{20}$/.test(body.externalId)) {
              return Response.json({ error: 'externalId must look like prn_ followed by 20 lowercase hex characters' }, { status: 400 });
            }
            // A principal is one agent (the premise `agents_external_pair_unique`, migration 0004,
            // enforces in the schema). Checked here first so a collision reads as a sentence, not a
            // raw UNIQUE-constraint failure; re-linking THIS agent to the principal it already has
            // is not a collision — that stays idempotent.
            const claimedBy = await findAgentByExternal(env.DB, 'org-plane', body.externalId);
            if (claimedBy && claimedBy.agentId !== agentId) {
              return Response.json({ error: `${body.externalId} is already linked to a different agent` }, { status: 409 });
            }
            await setAgentExternalMapping(env.DB, u.tenantId, agentId, { externalId: body.externalId, externalSource: 'org-plane' });
            return Response.json({ ok: true });
          }
          return Response.json({ error: 'method not allowed' }, { status: 405 });
        }
        if (request.method === 'GET') return Response.json({ agents: await listAgents(env.DB, u.tenantId) });
        if (request.method === 'POST') {
          const body = (await request.json()) as {
            name?: string;
            capabilities?: string[];
            /**
             * A suite principal this agent IS, linked as it is created.
             *
             * Optional, and its absence is the ordinary case: a standalone
             * superpipeline has no principals to name, and an agent nobody links is
             * a complete agent (migration 0003). What it removes is a
             * four-step chore — create, copy the `agt_` id, go find the `prn_`
             * in the other plane, PUT the link — and the window between the
             * create and the link where a failure leaves an agent that exists
             * and is linked to nobody.
             */
            externalId?: string;
          };
          if (!body.name || body.name.trim() === '') return Response.json({ error: 'name is required' }, { status: 400 });

          const linking = typeof body.externalId === 'string' && body.externalId.trim() !== '';
          if (linking) {
            // The same two checks the PUT path makes, made BEFORE anything is
            // written: a rejected link must leave no agent behind.
            if (!/^prn_[0-9a-f]{20}$/.test(body.externalId!)) {
              return Response.json({ error: 'externalId must look like prn_ followed by 20 lowercase hex characters' }, { status: 400 });
            }
            const claimedBy = await findAgentByExternal(env.DB, 'org-plane', body.externalId!);
            if (claimedBy) {
              return Response.json({ error: `${body.externalId} is already linked to a different agent` }, { status: 409 });
            }
          }

          // Same normalisation as PATCH. This path had none at all, so an agent could be created
          // with a capability spelled in a way no stage would ever match, and the only way to
          // discover that was a card that never moved.
          const wanted = capabilityTags(body.capabilities ?? []);
          const created = await createAgent(env.DB, u.tenantId, { name: body.name.trim(), capabilities: wanted });
          await ensureCapabilities(env.DB, u.tenantId, wanted, u.userId);

          if (linking) {
            await setAgentExternalMapping(env.DB, u.tenantId, created.id, {
              externalId: body.externalId!,
              externalSource: 'org-plane',
            });
            // No `spa_` token. A linked agent authenticates with hub JWTs
            // (`resolveHubAgent`), so minting one here would hand back a
            // long-lived secret the caller must store and never uses — and the
            // whole point of this path is to stop making the operator handle
            // credentials they did not ask for. An agent that later needs its
            // own native credential can still be issued one.
            return Response.json(
              { agent: { ...created, externalId: body.externalId, externalSource: 'org-plane' } },
              { status: 201 },
            );
          }

          const { id: tokenId, token } = await createAgentToken(env.DB, u.tenantId, created.id, AGENT_TOKEN_SCOPES);
          return Response.json({ agent: created, token, tokenId }, { status: 201 });
        }
        return Response.json({ error: 'method not allowed' }, { status: 405 });
      } catch (err) {
        return unexpected(err);
      }
    }

    const match = path.match(/^\/v1\/boards(?:\/([^/]+))?(?:\/(.*))?$/);
    // Anything that isn't an API route is the web app: hand it to the static assets (SPA fallback).
    if (!match) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not Found', { status: 404 });
    }

    const boardId = match[1];
    const rest = match[2] ?? '';

    // Before the agent/human split below, which classifies every `runs/*` path as an agent route.
    const evidenceMatch = boardId && request.method === 'GET' ? rest.match(/^runs\/([^/]+)\/evidence$/) : null;
    if (evidenceMatch) return runEvidence(request, env, boardId!, evidenceMatch[1]!);

    // Resolve the caller by route type: agent routes carry a token; the GitHub webhook
    // self-authenticates (HMAC) and carries ?tenant=; everything else is a human (session cookie).
    // `gates/pending` joins `claims` and `runs/*` as an agent route. It is a
    // read that names nobody and carries no authority — the widening is one
    // GET, not the surface. The alternative was for agentpod's bridge to mint
    // an assertion for a human on a timer so it could use the human-routed
    // board snapshot, which would make "a service may speak as a person" a
    // background job rather than the carrying of an answer that person gave.
    // `gates/pending` is readable by EITHER an agent or a human. It was widened to agents for
    // the bridge (above); classifying it as agent-only then refused the people whose decisions
    // it lists, because agent routes reject human credentials. `supi gates <boardId>` answered
    // 401 for every human token as a result. Whoever must make the decision has at least as much
    // business reading this as the service that relays it.
    // Reading ONE gate joins `gates/pending` on the same footing, and for the same reason: a
    // gate names nobody and carries no authority, and the caller that needs it is the hub asking
    // "is the gate I put in a room still open, and if not, what was decided?" — after which it
    // stops offering buttons for a decision already made. Deciding a gate stays human-only.
    // `elicitations/pending` joins them, and for exactly the reasons written above: it is the
    // same reconciliation read made by the same sweep, it names nobody and carries no authority,
    // and the people whose answers it lists have at least as much business reading it. Classifying
    // it human-only shipped on 2026-10-03 and every sweep pass 401'd within minutes — silently,
    // because the sweep settles nothing for a board it could not read.
    const isEitherRoute =
      !!boardId &&
      (rest === 'gates/pending' ||
        rest === 'elicitations/pending' ||
        /^gates\/[^/]+$/.test(rest));
    /**
     * What a COORDINATOR agent reaches: the board, one card, and creating a card.
     *
     * These are routes PEOPLE live on, so they join `gates/pending` as open to either — never as
     * agent-only. The first cut of this classified them as agent routes, and the comment three
     * paragraphs up had already written down why that is wrong: "classifying it as agent-only
     * then refused the people whose decisions it lists, because agent routes reject human
     * credentials." The failure was worse than a refusal. `resolveAgent`'s dev-header path
     * manufactures an agent out of `X-Tenant-Id` alone, and a dev-header agent carries no scopes
     * — which `scopePermits` reads as unscoped-and-therefore-unrestricted — so a VIEWER posting
     * to `cards` skipped `refuseByRole` entirely and got a 201. A role gate that a path can route
     * around is not a role gate.
     *
     * Method-scoped here as well as in `requiredScope`: a credential that may read a board must
     * not reach the agent branch to DELETE it. The two checks fail differently — this one picks
     * the branch, that one picks the scope — and a route admitted here with no scope opinion
     * would be a route an agent reaches unchecked.
     */
    const isCoordinatorRoute =
      // `/v1/boards` itself: GET lists them on `read`, POST composes one on `compose`.
      // `requiredScope` tells them apart from the board-scoped routes via `hasBoardId`, because
      // `rest` is empty for both `/v1/boards` and `/v1/boards/:id`.
      (!boardId && rest === '' && (request.method === 'GET' || request.method === 'POST')) ||
      (!!boardId &&
        ((request.method === 'GET' &&
          (rest === '' ||
            /^cards\/[^/]+$/.test(rest) ||
            /^cards\/[^/]+\/(activities|attempts|estimate)$/.test(rest))) ||
          (request.method === 'POST' && rest === 'cards') ||
          // `plan`: rearranging work that already exists. `requiredScope` decides which of these
          // needs which scope, and refuses the methods none of them may use.
          (request.method === 'PATCH' && /^cards\/[^/]+$/.test(rest)) ||
          (request.method === 'POST' && /^cards\/[^/]+\/move$/.test(rest)) ||
          ((request.method === 'POST' || request.method === 'DELETE') && rest === 'links') ||
          // ONE stage's prose, on `compose`. The body is then authorised field by field, so this
          // door opens for `instructions` and refuses every routing key behind it.
          (request.method === 'PATCH' && /^stages\/[^/]+$/.test(rest))));
    /**
     * Was an agent credential actually OFFERED?
     *
     * On a route open to both, the credential decides the branch rather than the path. A person
     * carries a session cookie or dev headers and must land in the human branch with its role
     * check; only a bearer token can be an agent's. A bearer that turns out to be a HUMAN's hub
     * token resolves no agent and falls through to the human branch, which knows how to read it.
     */
    const offersBearer = /^Bearer\s+\S/i.test(request.headers.get('Authorization') ?? '');
    /**
     * An agent subscribing ITSELF to a board's push (docs/05 §4: a config is "registered per
     * agent/board").
     *
     * This was a human route only, with the subscriber named by a caller-asserted `X-Agent-Id`, and
     * the one party that needs a subscription — the hub's bridge — holds an agent credential and
     * nothing else. So nobody ever registered one: every production board's delivery queue was
     * empty and a gate reached its room only when the hub's five-minute sweep found it. With a
     * bearer it resolves like a coordinator route — an agent token subscribes its own agent, and a
     * bearer that names no agent falls through to the human branch unchanged.
     */
    const isSubscriptionRoute = !!boardId && request.method === 'POST' && rest === 'push-configs';
    const isAgentRoute =
      (!!boardId && (rest === 'claims' || rest.startsWith('runs/') || isEitherRoute)) ||
      ((isCoordinatorRoute || isSubscriptionRoute) && offersBearer);
    // Both webhook doors self-authenticate by HMAC inside the DO, so neither carries a session.
    const isWebhook = !!boardId && (rest === 'webhooks/github' || rest === 'webhooks/forge');
    let tenantId: string;
    let user: UserPrincipal | null = null;
    let agent: AgentPrincipal | null = null;

    /**
     * Resolve the person behind this request and check their role, or return the refusal.
     *
     * One function because TWO arms need it. A route open to both agents and humans reaches the
     * agent arm first, and when no agent credential resolves there, the person on the other end
     * must get the whole human treatment — not a shortened version of it. The shortened version
     * is what let a viewer create a card.
     *
     * Returns the principal, or the `Response` to send instead. Returned rather than assigned to
     * `user` from inside the closure: TypeScript's control-flow analysis cannot see a write made
     * in a callback, so it kept `user` narrowed to `null` and every later `user?.userId` in this
     * handler became an error on type `never`. The compiler was right — a value set in a closure
     * is not a value this flow can prove is set.
     */
    const resolveHumanOrRefuse = async (): Promise<UserPrincipal | Response> => {
      let user = await resolveUser(request, env);
      // A hub-issued token is accepted on the human routes too, because the
      // routes that QUEUE work are where authority has to arrive: the grant is
      // recorded with the card and outlives the token that carried it.
      if (!user) user = await resolveHubUser(request, env);
      if (!user) return Response.json({ error: 'sign in to continue' }, { status: 401 });
      // A viewer reads the board; working it — creating, moving, editing and deleting cards,
      // resolving gates, answering an agent's question — is `member`, and reworking the board
      // itself is `admin`. GET is almost the whole read surface, so the method is the right
      // discriminator rather than a list of paths that would drift from the routes below it.
      //
      // Marking a notification read is the exception: it is a POST that changes nothing about the
      // board, only about what its recipient has already seen. A viewer who was assigned a card
      // receives notifications for it, and being unable to clear them would leave a badge they
      // can never dismiss.
      const needed: Capability =
        request.method === 'GET' || rest.startsWith('notifications/')
          ? 'read'
          : rest === '' || rest === 'stages' || rest === 'github' || rest === 'budget' || rest === 'profiles' || rest.startsWith('schedules')
            ? 'manage'
            : 'work';
      return refuseByRole(user, needed) ?? user;
    };

    if (isWebhook) {
      const t = url.searchParams.get('tenant');
      if (!t || t.trim() === '') return Response.json({ error: 'tenant required' }, { status: 400 });
      tenantId = t;
    } else if (isAgentRoute) {
      agent = await resolveAgent(request, env);
      // Mirrors the human fallback below: a node can now exchange its own credential for a
      // short-lived hub token whose sub is an agent principal, and superpipeline must accept it as
      // that agent — capabilities still come from superpipeline's own agents row, never the claim.
      if (!agent) agent = await resolveHubAgent(request, env);
      // A route open to both resolves as a human when no agent credential was offered, and falls
      // through to the human branch's own 401 rather than reporting "a valid agent token is
      // required" to a person who holds no agent token and needs none.
      if (!agent && (isEitherRoute || isCoordinatorRoute || isSubscriptionRoute)) {
        // Not a shortcut past the human branch — the SAME branch. A coordinator route reached
        // with a bearer that names no agent is still a person creating a card, and a person
        // creating a card is `work`. The earlier version of this resolved a user and stopped,
        // which on a GET was survivable and on `POST cards` would have been a role check skipped.
        const resolved = await resolveHumanOrRefuse();
        if (resolved instanceof Response) return resolved;
        user = resolved;
        tenantId = resolved.tenantId;
      } else {
        if (!agent) return Response.json({ error: 'a valid agent token is required' }, { status: 401 });
        // Scopes stop being decoration here. Every `spa_` token has carried a scope set since
        // migration 0001, the resolver has always returned it, and nothing compared it to the action
        // being attempted — so a token minted to claim drove every run verb. A recorded permission
        // nobody checks reads as protection that does not exist (auth/scopes.ts).
        const needed = requiredScope(rest, request.method, { hasBoardId: !!boardId });
        if (needed === SCOPE_FORBIDDEN) {
          return Response.json(
            { error: `an agent token cannot ${request.method} this route` },
            { status: 403 },
          );
        }
        if (needed && !scopePermits(agent.scopes, needed)) {
          return Response.json({ error: `this token is not permitted to ${needed}` }, { status: 403 });
        }
        tenantId = agent.tenantId;
      }
    } else {
      const resolved = await resolveHumanOrRefuse();
      if (resolved instanceof Response) return resolved;
      user = resolved;
      tenantId = resolved.tenantId;
    }

    try {
      // GET /v1/boards — list the workspace's boards · POST /v1/boards — create one
      if (!boardId) {
        if (request.method === 'GET') return Response.json({ boards: await listBoards(env.DB, tenantId) });
        if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });

        // Validated rather than asserted. The assertion `as { name: string; stages: StageDef[] }`
        // promised the compiler two fields the request had no obligation to carry, and the first
        // caller to get it wrong — `{"name": "…", "template": "software"}`, which is what a
        // reasonable person types — reached `[...board.stages]` inside the Durable Object and got
        // **HTTP 500 `board.stages is not iterable`**. A malformed request answered with a server
        // error, and an error that says `board.stages` to somebody who wrote `template` sends them
        // looking for a bug in the board.
        //
        // The checks stop at shape: a non-empty array of objects each carrying a string `key`.
        // What a *valid pipeline* is remains the board's decision — it normalises owners and
        // routing on the way in (`board-do.ts`) — and duplicating that here is how a route starts
        // refusing things the board would have accepted.
        const body = (await request.json().catch(() => null)) as { name?: unknown; stages?: unknown } | null;
        if (!body || typeof body !== 'object') {
          return Response.json({ error: { message: 'Expected a JSON object.' } }, { status: 400 });
        }
        if (typeof body.name !== 'string' || body.name.trim() === '') {
          return Response.json({ error: { message: '`name` is required and must be a non-empty string.' } }, { status: 400 });
        }
        if (!Array.isArray(body.stages) || body.stages.length === 0) {
          return Response.json(
            {
              error: {
                message:
                  '`stages` is required and must be a non-empty array. There is no `template` field — a client picks the stages and sends them.',
              },
            },
            { status: 400 },
          );
        }
        if (!body.stages.every((s) => s && typeof s === 'object' && typeof (s as { key?: unknown }).key === 'string')) {
          return Response.json({ error: { message: 'Every stage needs a string `key`.' } }, { status: 400 });
        }
        const name = body.name;
        const stages = body.stages as StageDef[];

        /**
         * An AGENT composing a board: owned by a real human, and bounded per day.
         *
         * A new board has no cards, which is why this is reachable at all — bad routing on an empty
         * board strands nothing, where changing a live stage re-routes every card on it. What still
         * has to hold is the rest of the queueing argument: somebody is answerable for it, and a loop
         * cannot make five hundred.
         */
        let composedByAgentId: string | null = null;
        let composedFor: string | null = user?.userId ?? null;
        if (agent) {
          const owner = agent.queueing?.ownerUserId ?? null;
          if (!owner) {
            return Response.json(
              {
                error: {
                  code: 'AGENT_HAS_NO_OWNER',
                  message: 'this agent has no owner, so there is nobody to be answerable for the board',
                },
              },
              { status: 403 },
            );
          }
          const ceiling = agent.queueing?.boardCeilingPerDay ?? 3;
          const already = await countBoardsComposedToday(env.DB, agent.agentId!);
          if (already >= ceiling) {
            return Response.json(
              {
                error: {
                  code: 'BOARD_CEILING_REACHED',
                  message: `this agent has composed ${already} boards today, at its ceiling of ${ceiling}`,
                },
              },
              { status: 429 },
            );
          }
          composedByAgentId = agent.agentId;
          composedFor = owner;
        }

        const id = newId('brd');
        const snapshot = await boardStub(env, tenantId, id).init({ id, tenantId, name, stages });
        await recordBoard(env.DB, tenantId, {
          id,
          name,
          stagesJson: JSON.stringify(snapshot.stages),
          // `boards` recorded no creator at all before this. An agent-composed board would otherwise
          // be indistinguishable from the operator's, which is the gap `queued_by_agent_id` closed
          // for cards.
          createdBy: composedFor,
          createdByAgentId: composedByAgentId,
        });
        // A stage naming a capability IS the act of declaring the workspace needs that work done,
        // so it registers the capability. Read from the SNAPSHOT rather than the request, because
        // the DO normalised the owners on the way in and the registry must record what was
        // actually stored, not what was asked for.
        await registerStageCapabilities(env, tenantId, snapshot.stages, user?.userId ?? null);
        return Response.json({ boardId: id, board: snapshot }, { status: 201 });
      }

      const stub = boardStub(env, tenantId, boardId);

      // GET /v1/boards/:id/ws — live feed (WebSocket upgrade forwarded to the DO)
      if (rest === 'ws') return stub.fetch(request);

      // GET /v1/boards/:id — board snapshot
      if (rest === '' && request.method === 'GET') {
        const snapshot: BoardSnapshot = await stub.getState();
        if (!snapshot.boardId) return Response.json({ error: 'board not found' }, { status: 404 });
        return Response.json(snapshot);
      }

      // PATCH /v1/boards/:id — rename the board (DO + catalog)
      if (rest === '' && request.method === 'PATCH') {
        const body = (await request.json()) as { name?: string };
        if (body.name && body.name.trim() !== '') {
          const r = await stub.setName(body.name.trim());
          if (!r.ok) return Response.json({ error: r }, { status: statusForCode(r.code) });
          await renameBoard(env.DB, tenantId, boardId, body.name.trim());
        }
        return Response.json(await stub.getState());
      }

      // PATCH /v1/boards/:id/stages/:stageKey — change ONE stage (docs/15 §5)
      //
      // Beside the whole-pipeline PUT rather than replacing it: reordering and adding stages are
      // statements about the pipeline and stay there. This is for the fields that belong to one
      // stage, where a full replace would discard a concurrent edit to a stage nobody touched.
      const stageMatch = rest.match(/^stages\/([^/]+)$/);
      if (stageMatch && request.method === 'PATCH') {
        const body = (await request.json().catch(() => null)) as StagePatch | null;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return Response.json({ error: 'a stage patch must be a JSON object' }, { status: 400 });
        }
        /**
         * An agent may set a stage's `instructions` and nothing else.
         *
         * `compose` opened this route for prose; the body is where the rest is refused. `instructions`
         * is what an agent is handed when it claims the stage, and wrong prose is bad work — visible
         * in a handoff, recoverable, costing one card. `owner`, `requires`, `gate` and `wipLimit` are
         * routing, and wrong routing strands every card in the lane with nothing to see.
         */
        if (agent) {
          const refusal = stagePatchRefusal(body as Record<string, unknown>);
          if (refusal) {
            return Response.json({ error: { code: 'FIELD_NOT_COMPOSABLE', message: refusal } }, { status: 403 });
          }
        }
        // Named rather than ignored. A caller sending `key` means to rename the stage, and
        // silently dropping it would report success for a change that did not happen.
        for (const forbidden of ['key', 'order'] as const) {
          if (forbidden in body) {
            return Response.json(
              { error: `\`${forbidden}\` is not patchable — use PUT /stages, where its effect on the other stages is visible` },
              { status: 400 },
            );
          }
        }
        // Built from named fields rather than forwarding `body` whole: the cast above names the
        // same type `updateStage` accepts, but it is still only a compile-time assertion — it does
        // not stop a caller's JSON from carrying a key the type never declared.
        const result = await stub.updateStage(stageMatch[1]!, {
          name: body.name,
          owner: body.owner,
          ownerKind: body.ownerKind,
          requires: body.requires,
          gate: body.gate,
          wipLimit: body.wipLimit,
          instructions: body.instructions,
          completion: body.completion,
        });
        if (!result.ok) {
          // `UNKNOWN_STAGE` is a 400 in the shared mapping, which is right where the stage is in
          // the BODY — `move` asking for a lane that does not exist is a bad request. Here it is a
          // path segment, and a path naming nothing is a 404: that is how a caller tells a typo in
          // the URL from a bad payload without reading the message.
          const status = result.code === 'UNKNOWN_STAGE' ? 404 : statusForCode(result.code);
          return Response.json({ error: result }, { status });
        }
        return Response.json(result.value);
      }

      // PUT /v1/boards/:id/stages — rework the pipeline (docs/03).
      //
      // The whole list, not a patch: order is a property of the list rather than of any stage in
      // it, so a partial update cannot express a reorder. The DO validates and refuses first; the
      // catalog's `stages_json` is only mirrored after that succeeds, so a rejected change never
      // leaves the two disagreeing about what the board's pipeline is.
      if (rest === 'stages' && request.method === 'PUT') {
        const body = (await request.json()) as { stages?: StageDef[] };
        const r = await stub.setStages(body.stages ?? []);
        if (!r.ok) return Response.json({ error: r }, { status: statusForCode(r.code) });
        await updateBoardStages(env.DB, tenantId, boardId, JSON.stringify(r.value.stages));
        await registerStageCapabilities(env, tenantId, r.value.stages, user?.userId ?? null);
        return Response.json(await stub.getState());
      }

      // DELETE /v1/boards/:id — remove the board, and everything it held.
      //
      // This used to delete the catalog row alone, leaving the Durable Object and all its cards,
      // runs, activities and references alive: unreachable through any route, undeleted, and
      // still billing storage. A person who deleted a board had every reason to believe its
      // contents were gone.
      //
      // The DO is emptied FIRST. If that throws, the catalog row survives and the board is still
      // listed and still reachable — a delete that visibly did not happen, rather than a board
      // that vanished from the list while its contents quietly stayed.
      //
      // That ordering only works if the SECOND half — `deleteBoard` — cannot fail. It used to be
      // a bare `DELETE FROM boards`, which was safe only because nothing referenced that table.
      // Migration 0012 changed that: `card_links_external` FKs onto `boards(id)` with no `ON
      // DELETE`, so a board named by any cross-board advisory edge started throwing here, AFTER
      // the DO was already gone — the exact "quiet loss" this comment describes, just moved to
      // the other half. `deleteBoard` (`db/catalog.ts`) now cleans those rows in the SAME batch as
      // the board itself, so this call cannot fail on that FK. Whoever next adds a foreign key
      // onto `boards(id)`: it needs the same treatment here, not a reordering of these two lines —
      // reordering only relocates the failure window to the irreversible half.
      if (rest === '' && request.method === 'DELETE') {
        await stub.destroy();
        await deleteBoard(env.DB, tenantId, boardId);
        return new Response(null, { status: 204 });
      }

      // POST /v1/boards/:id/cards — create a card (owner defaults to the signed-in user)
      if (rest === 'cards' && request.method === 'POST') {
        const body = (await request.json()) as {
          title: string;
          ownerUserId?: string;
          spec?: JsonValue;
          priority?: number;
          dueAt?: string;
        };
        if (isInvalidDueAt(body.dueAt)) {
          return Response.json(
            { error: { code: 'INVALID_DUE_AT', message: 'dueAt must be null or a date in YYYY-MM-DD form' } },
            { status: 400 },
          );
        }
        // The authority that accompanied the act, recorded with the card. A
        // session-cookie caller carries none, and `undefined` there means "no
        // one with permission asked for this to run" — which is refused under
        // enforcement rather than treated as an empty grant.
        //
        // Built from named fields rather than `...body`: `as` above is a compile-time assertion
        // only — it strips nothing at runtime, so a caller sending ANY key (`projectId` among
        // them: `createCard`'s own input type carries it for `createChildCard`'s internal use
        // alone, board-do.ts) would have had it spread straight through to the DO. A cast is not
        // validation, so the route has to name what it accepts rather than forward what it
        // received.
        /**
         * Who is answerable for this card, and on whose authority it may be dispatched.
         *
         * Two callers now reach here. For a person the two have always been the same value and
         * `ownerUserId` ended with `?? 'usr_dev'`; for an AGENT that literal would have owned real
         * work to a user that exists in no workspace, and `user?.mayDispatch` would have been
         * `undefined` — a null grant, which the control pair refuses at claim time. So an agent
         * could have created cards that nothing could ever claim: queued-looking, and dead.
         */
        const queueing = agent
          ? await authorizeAgentQueue(env.DB, agent, boardId, body.ownerUserId)
          : null;
        if (queueing && !queueing.ok) {
          return Response.json(
            { error: { code: queueing.code, message: queueing.message } },
            { status: queueing.status },
          );
        }
        const result = await stub.createCard({
          title: body.title,
          spec: body.spec,
          priority: body.priority,
          dueAt: body.dueAt,
          ownerUserId: queueing ? queueing.ownerUserId : body.ownerUserId ?? user!.userId,
          queuedGrant: queueing ? queueing.queuedGrant : user?.mayDispatch ?? null,
          // Null for a person, and that is the whole signal: every card on every board today was
          // queued by one, and a reader must be able to see at a glance which ones were not.
          queuedBy: queueing ? queueing.queuedBy : null,
          queuedByAgentId: agent?.agentId ?? null,
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        // Written AFTER the card exists, so the ceiling counts cards that were actually created
        // rather than attempts — and so a board that refused the card does not spend the agent's
        // hourly budget on nothing.
        if (agent?.agentId) {
          await recordAgentQueue(env.DB, {
            tenantId,
            agentId: agent.agentId,
            boardId,
            cardId: result.value.id,
          });
        }
        return Response.json({ card: result.value }, { status: 201 });
      }

      // POST /v1/boards/:id/cards/:cardId/move — move a card
      const moveMatch = rest.match(/^cards\/([^/]+)\/move$/);
      if (moveMatch && request.method === 'POST') {
        const body = (await request.json()) as { toStageKey: string };
        // The mover is passed through: whoever moves a card into a dispatchable
        // stage is the one dispatching it now, and the control pair needs a
        // principal to check at claim time. `moveCard` has always accepted an
        // actor; this route never sent one, so every move looked anonymous.
        /**
         * Moving a card into a dispatchable stage IS dispatching it — `moveCard` stamps `queued_by`
         * and `queued_grant` for exactly that reason. So an AGENT mover goes through the same gate a
         * create does: the board allowlist, an owner, a real grant, and the hourly ceiling.
         *
         * Without this an agent could launder authority: move a card it could never have queued, and
         * the card would keep the last human's grant while the agent chose the work. `user!` here
         * would also have thrown — a 500 rather than a refusal — the moment this route admitted one.
         */
        const mover = agent ? await authorizeAgentQueue(env.DB, agent, boardId) : null;
        if (mover && !mover.ok) {
          return Response.json(
            { error: { code: mover.code, message: mover.message } },
            { status: mover.status },
          );
        }
        const result = await stub.moveCard(
          moveMatch[1]!,
          body.toStageKey,
          mover ? mover.queuedBy : user!.userId,
          mover ? mover.queuedGrant : user?.mayDispatch ?? null,
          mover ? agent!.agentId : null,
        );
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ card: result.value });
      }

      // GET /v1/boards/:id/cards/:cardId — one card · PATCH — edit it · DELETE — remove it
      const cardMatch = rest.match(/^cards\/([^/]+)$/);
      /**
       * The read arm did not exist until #90, so `supi card` — which has requested exactly this
       * path since it was written — answered 405 on every invocation, for every board and every
       * card, while `supi --help` advertised it as "one card in full". The subroutes below
       * (`/attempts`, `/activities`, `/estimate`) all serve GET; the card itself was the one
       * thing under this prefix nobody could read, and the absence was routed around by filtering
       * the whole board snapshot client-side.
       *
       * Bodied as `{ card }`, which is what PATCH already answers with, so one client parses both.
       */
      if (cardMatch && request.method === 'GET') {
        const result = await stub.getCardView(cardMatch[1]!);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ card: result.value });
      }
      if (cardMatch && request.method === 'PATCH') {
        const body = (await request.json()) as {
          title?: string;
          spec?: JsonValue;
          priority?: number;
          ownerUserId?: string;
          labels?: string[];
          /**
           * The free-text names `CardDrawer.svelte`'s comma-separated Labels input sends —
           * resolved to catalogue ids here rather than in the client, since the resolver both
           * reads and writes D1 (`resolveLabelNames`, `src/db/labels.ts`). A name not yet in the
           * catalogue is created with `origin: 'inferred'` (migration 0011), the same treatment
           * `capabilities` gives a tag "registered on first use". Sent instead of `labels`, never
           * alongside it — the drawer is the one caller, and it only ever has names.
           */
          labelNames?: string[];
          dueAt?: string | null;
          archivedAt?: string | null;
          /** Cross-board project/milestone membership (migration 0013; Task 19). `null` clears it. */
          projectId?: string | null;
          milestoneId?: string | null;
        };
        if (body.ownerUserId !== undefined && (typeof body.ownerUserId !== 'string' || body.ownerUserId.trim() === '')) {
          return Response.json({ error: 'ownerUserId must be a non-empty user id' }, { status: 400 });
        }
        if (isInvalidDueAt(body.dueAt)) {
          return Response.json(
            { error: { code: 'INVALID_DUE_AT', message: 'dueAt must be null or a date in YYYY-MM-DD form' } },
            { status: 400 },
          );
        }
        if (
          body.archivedAt !== undefined &&
          body.archivedAt !== null &&
          (typeof body.archivedAt !== 'string' || Number.isNaN(Date.parse(body.archivedAt)))
        ) {
          return Response.json(
            { error: { code: 'INVALID_ARCHIVED_AT', message: 'archivedAt must be null or an ISO timestamp' } },
            { status: 400 },
          );
        }
        if (body.labelNames !== undefined) {
          if (!Array.isArray(body.labelNames) || body.labelNames.some((n) => typeof n !== 'string')) {
            return Response.json(
              { error: { code: 'INVALID_LABELS', message: 'labelNames must be an array of strings' } },
              { status: 400 },
            );
          }
          // Resolved BEFORE the unknown-id check below, so a freshly created id still passes it —
          // it was just inserted into the same tenant's catalogue this request resolved against.
          body.labels = await resolveLabelNames(env.DB, tenantId, body.labelNames, user?.userId ?? null);
        }

        // The DO does not validate label ids — it cannot reach D1 usefully on a hot path — so the
        // route checks here, before the write lands, that every id names a real label in this
        // workspace's catalogue.
        if (body.labels !== undefined) {
          // The type guard is not decoration. Without it, `labels: "urgent"` skips this whole check
          // and reaches `[...new Set(patch.labels)]` in the DO, where a string is iterable and spreads
          // into ['u','r','g','e','n','t'] — written to storage, no error raised. A plain object
          // throws an unhandled TypeError inside the DO instead. Neither answers 400.
          if (!Array.isArray(body.labels) || body.labels.some((l) => typeof l !== 'string')) {
            return Response.json(
              { error: { code: 'INVALID_LABELS', message: 'labels must be an array of label ids' } },
              { status: 400 },
            );
          }
          const unknown = await unknownLabelIds(env.DB, tenantId, body.labels as string[]);
          if (unknown.length > 0) {
            return Response.json(
              { error: { code: 'UNKNOWN_LABEL', message: `no such label in this workspace: ${unknown.join(', ')}` } },
              { status: 400 },
            );
          }
        }
        // Milestones are in D1; the DO cannot check that a milestone belongs to the project it is
        // attached under, so the route does — the same shape `labels` just took above. Unlike
        // labels, this is a RELATIONSHIP check, not an existence check: a `projectId` that no
        // longer resolves is a normal state here (see the long comment on `deleteProject` in
        // `db/projects.ts`), and nothing above refuses it. A `milestoneId`, though, is only ever
        // meaningful alongside the project it was created under.
        //
        // Checked whenever EITHER half of the pair could change, not only when `milestoneId` is in
        // the body — `PATCH { projectId: B }` on a card carrying `{ projectId: A, milestoneId: mA
        // }` changes the pair just as much as sending `milestoneId` would, and silently leaving
        // `mA` (project A's milestone) attached to a card now in project B is the same invariant
        // violation. Refused, not silently cleared: clearing would discard a commitment the caller
        // never asked to drop.
        if (body.milestoneId !== undefined || body.projectId !== undefined) {
          let effectiveMilestoneId = body.milestoneId;
          let effectiveProjectId = body.projectId;
          if (effectiveMilestoneId === undefined || effectiveProjectId === undefined) {
            const current = await stub.getCardView(cardMatch[1]!);
            if (!current.ok) return Response.json({ error: current }, { status: statusForCode(current.code) });
            if (effectiveMilestoneId === undefined) effectiveMilestoneId = current.value.milestoneId;
            if (effectiveProjectId === undefined) effectiveProjectId = current.value.projectId;
          }
          if (effectiveMilestoneId) {
            const milestone = effectiveProjectId ? await milestoneById(env.DB, tenantId, effectiveMilestoneId) : null;
            if (!milestone || milestone.projectId !== effectiveProjectId) {
              return Response.json(
                {
                  error: {
                    code: 'MILESTONE_NOT_IN_PROJECT',
                    message: "milestoneId does not belong to the card's project",
                  },
                },
                { status: 400 },
              );
            }
          }
        }
        // Built from named fields rather than forwarding `body` whole: the cast above strips
        // nothing at runtime, so the route has to name what `updateCard` accepts rather than
        // forward what it received — `labelNames` is deliberately excluded here, since it was
        // already resolved into `body.labels` above and `updateCard`'s patch type has no field for
        // it at all.
        const result = await stub.updateCard(cardMatch[1]!, {
          title: body.title,
          spec: body.spec,
          priority: body.priority,
          ownerUserId: body.ownerUserId,
          labels: body.labels,
          dueAt: body.dueAt,
          archivedAt: body.archivedAt,
          projectId: body.projectId,
          milestoneId: body.milestoneId,
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ card: result.value });
      }
      if (cardMatch && request.method === 'DELETE') {
        const result = await stub.deleteCard(cardMatch[1]!);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        // `deleteCard` cleans the DO's own same-board `card_links` in both directions, for a
        // reason that applies identically to Task 16's cross-board advisory store: a lingering
        // edge would point at a card that no longer exists. The DO cannot reach D1, so this is
        // that same cleanup's other half, run here once the DO has confirmed the card existed.
        await deleteExternalLinksForCard(env.DB, tenantId, cardMatch[1]!);
        return new Response(null, { status: 204 });
      }

      // POST /v1/boards/:id/links — declare an edge · DELETE — remove one (spec §3.4).
      //
      // Task 12 built `addLink`/`removeLink` on the Durable Object (`board-do.ts:2139-2199`) with
      // no HTTP surface; Task 17a gave it one, for the drawer's "Add blocker" and `supi link`.
      //
      // Task 17d: the SAME route also carries Task 16's cross-board advisory edges
      // (`db/card-links-external.ts`), via an optional `toBoardId` alongside `toCardId`. One
      // route, and the DATA decides the store: `toBoardId` absent, or equal to the path's own
      // board, stays same-board (the DO, enforced); any other value routes to D1 (advisory, never
      // read on the claim path). The client names where the other end of the edge lives — it never
      // picks the store, which is what keeps the enforced/advisory distinction from becoming a lie
      // a client could tell by choosing wrong.
      //
      // Shape-checked here, not left to the DO or the D1 module: both trust their callers by
      // design, so `kind` outside the known set — and now a malformed `toBoardId` — are refused as
      // a 400 before either is called, rather than being stored or crashing downstream.
      if (rest === 'links' && (request.method === 'POST' || request.method === 'DELETE')) {
        const body = (await request.json().catch(() => null)) as
          | { fromCardId?: unknown; toCardId?: unknown; kind?: unknown; toBoardId?: unknown }
          | null;
        if (!body || typeof body !== 'object') {
          return Response.json({ error: { message: 'Expected a JSON object.' } }, { status: 400 });
        }
        if (
          typeof body.fromCardId !== 'string' ||
          body.fromCardId.trim() === '' ||
          typeof body.toCardId !== 'string' ||
          body.toCardId.trim() === ''
        ) {
          return Response.json(
            { error: { code: 'INVALID_LINK', message: 'fromCardId and toCardId are required, non-empty card ids' } },
            { status: 400 },
          );
        }
        if (body.kind !== 'blocks' && body.kind !== 'relates' && body.kind !== 'parent') {
          return Response.json(
            {
              error: {
                code: 'INVALID_LINK_KIND',
                message: `kind must be 'blocks', 'relates' or 'parent', got ${JSON.stringify(body.kind)}`,
              },
            },
            { status: 400 },
          );
        }
        if (body.toBoardId !== undefined && (typeof body.toBoardId !== 'string' || body.toBoardId.trim() === '')) {
          return Response.json(
            { error: { code: 'INVALID_LINK', message: 'toBoardId must be a non-empty board id when present' } },
            { status: 400 },
          );
        }
        const kind: LinkKind = body.kind;
        const fromCardId = body.fromCardId;
        const toCardId = body.toCardId;
        const toBoardId = typeof body.toBoardId === 'string' ? body.toBoardId : boardId;

        if (toBoardId !== boardId) {
          // Cross-board: Task 16's advisory D1 store. `parent` is refused here rather than handed
          // to the module: `ExternalLinkKind` excludes it, and — unlike `addExternalLink` —
          // `removeExternalLink` performs no validation of its own, so a DELETE with kind=parent
          // would otherwise silently no-op (nothing was ever written under that kind) instead of
          // saying why such an edge can never exist. Same code and message `addExternalLink` would
          // give, so POST and DELETE disagree about nothing.
          if (kind === 'parent') {
            return Response.json(
              {
                error: {
                  code: 'PARENT_MUST_BE_SAME_BOARD',
                  message:
                    "A parent edge carries a rule — a parent does not advance while a child is open — and an advisory containment relationship is one that fails to contain. Use a project to group cards across boards.",
                },
              },
              { status: 400 },
            );
          }
          if (request.method === 'POST') {
            const result = await addExternalLink(env.DB, tenantId, {
              from: { boardId, cardId: fromCardId },
              to: { boardId: toBoardId, cardId: toCardId },
              kind,
            });
            if (!result.ok) return Response.json({ error: result }, { status: statusForExternalLinkCode(result.code) });
            return Response.json(
              { link: { fromBoardId: boardId, fromCardId, toBoardId, toCardId, kind, enforced: false as const } },
              { status: 201 },
            );
          }
          await removeExternalLink(env.DB, tenantId, fromCardId, toCardId, kind);
          return Response.json({ ok: true, enforced: false as const });
        }

        // Same-board: Task 12's enforced edge on the DO, unchanged from Task 17a except that the
        // response now names its own `enforced` boolean too, matching the cross-board arm above so
        // a caller never has to infer enforcement from whether `toBoardId` was sent.
        if (request.method === 'POST') {
          const result = await stub.addLink({ fromCardId, toCardId, kind, createdBy: user?.userId ?? null });
          if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
          return Response.json({ link: { ...result.value, enforced: true as const } }, { status: 201 });
        }
        const result = await stub.removeLink(fromCardId, toCardId, kind);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ ...result.value, enforced: true as const });
      }

      // POST /v1/boards/:id/cards/:cardId/split — decompose a card into claimable children, one
      // per (non-blank) line (Task 15, spec §3.4). A human/web route: the agent path reaches
      // `splitCard` through `superpipeline_split_card` (scope `run`) instead, calling the same DO
      // method directly — this route and that tool are the same contract on two wires.
      const splitMatch = rest.match(/^cards\/([^/]+)\/split$/);
      if (splitMatch && request.method === 'POST') {
        const body = (await request.json().catch(() => null)) as { titles?: unknown } | null;
        if (!body || typeof body !== 'object') {
          return Response.json({ error: { message: 'Expected a JSON object.' } }, { status: 400 });
        }
        // Shape-checked here — the DO trusts its callers by design — so a malformed body answers
        // 400 rather than reaching `splitCard` and failing in a way that points at the wrong layer.
        if (!Array.isArray(body.titles) || body.titles.some((t) => typeof t !== 'string')) {
          return Response.json({ error: { message: '`titles` is required and must be an array of strings.' } }, { status: 400 });
        }
        const result = await stub.splitCard(splitMatch[1]!, body.titles as string[], user?.userId ?? 'usr_dev');
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ children: result.value.children }, { status: 201 });
      }

      // PUT /v1/boards/:id/cards/:cardId/references — idempotent reference upsert (docs/06 §1)
      const refMatch = rest.match(/^cards\/([^/]+)\/references$/);
      if (refMatch && request.method === 'PUT') {
        const body = (await request.json()) as {
          url: string;
          provider?: string;
          sourceType?: string;
          title?: string;
          subtitle?: string;
          externalId?: string;
          metadata?: Record<string, unknown>;
          addedBy?: 'agent' | 'user';
        };
        // Parsed, not cast. `ReferenceProvider` documented a constraint nothing imposed — the
        // routes cast request bodies — so `provider: "web"` reached a live card on 2026-09-28.
        // Checked HERE and nowhere else on this path, because this is the only door a caller
        // supplies a provider through.
        //
        // A WRITE rule only: rows written before this exists are read back untouched, and a read
        // that threw on them would turn a tightening into an outage.
        if (body.provider !== undefined && !isKnownProvider(String(body.provider))) {
          return Response.json(
            { error: `unknown reference provider: ${String(body.provider)}. Known: ${providerKeys().join(', ')}` },
            { status: 400 },
          );
        }

        // The tenant's forge host is read here rather than held in the DO: it is a workspace
        // fact, and a board that cached it would keep enriching against a host the workspace had
        // already changed.
        const refTenant = await tenantById(env.DB, tenantId);
        // Built from named fields rather than `{ cardId, ...body }`: the spread came AFTER the path
        // segment, and `resolveReferenceInput` reads `cardId` off its argument — so a body carrying
        // its own `cardId` won outright and the reference attached to a card the URL never named.
        // The cast above does not even declare `cardId`; it arrived as an extra key, because `as`
        // strips nothing at runtime. A cast is not validation, so the route has to name what it
        // accepts rather than forward what it received — the same lesson as the `provider: "web"`
        // incident this route's comment above already records.
        const result = await stub.addReference(
          resolveReferenceInput(
            {
              cardId: refMatch[1]!,
              url: body.url,
              provider: body.provider,
              sourceType: body.sourceType,
              title: body.title,
              subtitle: body.subtitle,
              externalId: body.externalId,
              metadata: body.metadata,
              addedBy: body.addedBy,
            },
            refTenant?.forgeHost ?? null,
          ),
        );
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ reference: result.value });
      }

      // GET /v1/boards/:id/cards/:cardId/attempts — attempts comparison (docs/07 §5)
      const attemptsMatch = rest.match(/^cards\/([^/]+)\/attempts$/);
      if (attemptsMatch && request.method === 'GET') {
        return Response.json({ attempts: await stub.getAttempts(attemptsMatch[1]!) });
      }

      // GET /v1/boards/:id/cards/:cardId/activities — session-replay timeline + handoff (docs/07 §4)
      const cardActMatch = rest.match(/^cards\/([^/]+)\/activities$/);
      if (cardActMatch && request.method === 'GET') {
        return Response.json(await stub.getCardActivities(cardActMatch[1]!));
      }

      // GET /v1/boards/:id/cards/:cardId/estimate — pre-run cost estimate (docs/07 §6)
      const estimateMatch = rest.match(/^cards\/([^/]+)\/estimate$/);
      if (estimateMatch && request.method === 'GET') {
        const result = await stub.estimateCardCost(estimateMatch[1]!);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value);
      }

      // GET /v1/boards/:id/cards/:cardId/links — every edge touching this card, from both stores.
      //
      // `links` (same-board, from the DO's `listLinks`) and `externalLinks` (cross-board, from
      // Task 16's advisory D1 rows, `card-links-external.ts`) are kept in two separate arrays
      // rather than merged into one list, and each row also carries its own `enforced` boolean —
      // belt and braces, because the two kinds mean different things. A same-board `blocks` is
      // read on the claim path and genuinely refuses a claim; a cross-board `blocks` is shown and
      // nothing more — `addExternalLink`'s own comment calls it "advisory, always". A client that
      // merged them into one list, or told them apart only by comparing `toBoardId` to this
      // board's id, is one bug away from drawing an enforced badge on an edge that enforces
      // nothing. 17b's badge logic is built on this response never requiring that inference.
      //
      // 17b follow-up: the specified tooltip ("Blocked by *Title* on *Board* — not enforced across
      // boards") needs a title and a board name, and `ExternalLinkRow` only ever carried ids. Each
      // `externalLinks` row here also carries `otherBoardName`/`otherCardTitle` for whichever end
      // is NOT `cardId` — a cheap tenant-scoped D1 read for the name, and a per-row, on-demand
      // cross-DO read for the title. This is the ONLY place that title read happens: it is not
      // added to `listExternalLinksFor` (the module stays free of cross-DO concerns) and it never
      // informs a claim or advance decision — the whole reason the edge is advisory rather than
      // enforced is that a cross-DO read is stale the instant it returns, and that stays true of
      // this one too; it exists solely to label one drawer, once, on request.
      const cardLinksMatch = rest.match(/^cards\/([^/]+)\/links$/);
      if (cardLinksMatch && request.method === 'GET') {
        const cardId = cardLinksMatch[1]!;
        const [links, externalLinks] = await Promise.all([
          stub.listLinks(cardId),
          listExternalLinksFor(env.DB, tenantId, cardId),
        ]);

        // The other end of each advisory edge — `listExternalLinksFor` matches `cardId` from
        // EITHER side, so which field holds "the other card" depends on the row's direction.
        const otherEnds = externalLinks.map((l) =>
          l.fromCardId === cardId
            ? { boardId: l.toBoardId, cardId: l.toCardId }
            : { boardId: l.fromBoardId, cardId: l.fromCardId },
        );
        // Tenant-scoped by the WHERE clause itself: a board this tenant does not own is simply
        // absent from the map. That is deliberate defence in depth, not redundant with
        // `addExternalLink`'s own `FOREIGN_BOARD` guard at write time — this read must not assume
        // every row in the table got there through that guard. Boards not owned by the tenant, or
        // no longer present at all, degrade to `otherBoardName: null` the same way an unresolved
        // title does, never a leak or a failure.
        const boardNames = await boardNamesById(env.DB, tenantId, otherEnds.map((e) => e.boardId));
        // One on-demand, per-row cross-DO read per advisory edge, run in parallel rather than
        // sequentially — not batched into a single multi-card DO call. Considered and rejected for
        // now: these rows are hand-added one at a time through a board-picker dialogue, so the
        // realistic count for one card is a handful at most, and rows just as often name DIFFERENT
        // boards (nothing to batch within) as the same one. A batched "read several cards" RPC
        // would mean a new Durable Object method, which is out of this route's scope. Skipped
        // entirely — no DO call at all — for any end whose board did not resolve above, so a
        // foreign board is never even asked, not just never shown.
        const otherTitles = await Promise.all(
          otherEnds.map((e) => (boardNames.has(e.boardId) ? getOtherCardTitle(env, tenantId, e.boardId, e.cardId) : null)),
        );

        return Response.json({
          // `enforced` must mean what it says: true only for a same-board edge that can actually
          // refuse a claim. `blockedWhere` has two clauses — an unresolved `blocks` edge pointing
          // AT a card, and an open child (`parent`) pointing FROM one — so both `blocks` and
          // `parent` genuinely enforce something; `relates` is decoration, consulted nowhere.
          // Stamping every kind `true` unconditionally told a client a `relates` edge refuses a
          // claim it does not — unreachable today only because of a web-side defect being fixed
          // separately, and the whole point of this flag is that a client should never have to
          // infer enforcement itself, including for the one kind that has none.
          links: links.map((l) => ({ ...l, enforced: l.kind !== 'relates' })),
          externalLinks: externalLinks.map((l, i) => ({
            ...l,
            enforced: false as const,
            otherBoardName: boardNames.get(otherEnds[i]!.boardId) ?? null,
            otherCardTitle: otherTitles[i] ?? null,
          })),
        });
      }

      // GET /v1/boards/:id/events — the board's own event log (docs/03).
      //
      // `BoardDO.getEvents` has existed since the DO did, with no route and no caller: every
      // state change on a board — created, moved, claimed, blocked, resolved — was appended to
      // `events` and there was no way to read it back. The only audit trail the product keeps was
      // unreachable, which is the same as not keeping one.
      if (rest === 'events' && request.method === 'GET') {
        const limitParam = Number(url.searchParams.get('limit'));
        const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;
        return Response.json({ events: await stub.getEvents(limit) });
      }

      // GET /v1/boards/:id/usage — cost/usage rollup (docs/07 §6). `?window=` filters to a recent span.
      if (rest === 'usage' && request.method === 'GET') {
        const window = url.searchParams.get('window');
        return Response.json(await stub.getUsage(window ? { window } : undefined));
      }

      // GET /v1/boards/:id/notifications — in-app notification feed (docs/07 §7)
      if (rest === 'notifications' && request.method === 'GET') {
        const unreadOnly = url.searchParams.get('unread') === 'true';
        // Scoped to the caller: `user_id` was written and never read, so every board notification
        // reached every member of the workspace.
        return Response.json({ notifications: await stub.getNotifications({ unreadOnly, userId: user!.userId }) });
      }

      // POST /v1/boards/:id/notifications/:seq/read — mark a notification read (docs/07 §7)
      const notifReadMatch = rest.match(/^notifications\/(\d+)\/read$/);
      if (notifReadMatch && request.method === 'POST') {
        const r = await stub.markNotificationRead(Number(notifReadMatch[1]));
        return Response.json(r.ok ? r.value : { error: r });
      }

      // GET/POST /v1/boards/:id/profiles — agent profiles as data (docs/05 §7)
      if (rest === 'profiles' && request.method === 'GET') {
        return Response.json({ profiles: await stub.getProfiles() });
      }
      if (rest === 'profiles' && request.method === 'POST') {
        const body = (await request.json()) as {
          key: string;
          name?: string;
          harness?: string;
          model?: string;
          permissionPolicy?: string;
          autonomyLevel?: string;
          capabilities?: string[];
        };
        // Built from named fields rather than forwarding `body` whole: the cast above strips
        // nothing at runtime, so the route has to name what `setProfile` accepts.
        const result = await stub.setProfile({
          key: body.key,
          name: body.name,
          harness: body.harness,
          model: body.model,
          permissionPolicy: body.permissionPolicy,
          autonomyLevel: body.autonomyLevel,
          capabilities: body.capabilities,
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value, { status: 201 });
      }

      // GET/POST /v1/boards/:id/schedules · PATCH/DELETE /v1/boards/:id/schedules/:scheduleId
      // (Task 10 — the reachable half of Task 8's rule grammar and Task 9's `createSchedule` /
      // `updateSchedule` / `deleteSchedule` / `listSchedules` on the DO. Neither had a route until
      // this block; a whole-branch review is what found labels shipped exactly this gap twice
      // (`labels: "urgent"` and `dueAt: 12345`), so the type guards below are deliberate, not
      // decoration.
      //
      // `createSchedule`/`updateSchedule` validate the RULE TEXT, the timezone STRING, `stageKey`,
      // `overlap` and `createdBy` — but they trust the JSON SHAPE that reaches them, because the DO
      // cannot reach D1 on a hot path to check it itself. A non-string `rule` reaches `parseRule`'s
      // `s.trim()` and throws (a 500), not a graceful `INVALID_RULE`. That is refused here, before
      // the DO ever sees it — the same class of hole `dueAt: 12345` opened on `POST /cards`.
      //
      // `createdBy` is never read from the body: the route supplies the authenticated user, exactly
      // as `createCard`'s `ownerUserId` defaults to it — Principle 3, every card (and here, every
      // schedule that mints one) has a human owner recorded at the moment of the act, not asked of
      // the caller.
      const schedulesMatch = rest.match(/^schedules(?:\/([^/]+))?$/);
      if (schedulesMatch) {
        const scheduleId = schedulesMatch[1];

        if (request.method === 'GET' && !scheduleId) {
          return Response.json({ schedules: await stub.listSchedules() });
        }

        if (request.method === 'POST' && !scheduleId) {
          const body = (await request.json().catch(() => null)) as {
            title?: unknown;
            rule?: unknown;
            timezone?: unknown;
            overlap?: unknown;
            stageKey?: unknown;
            priority?: unknown;
            labels?: unknown;
            spec?: JsonValue;
            enabled?: unknown;
          } | null;
          if (!body || typeof body !== 'object') {
            return Response.json({ error: { message: 'Expected a JSON object.' } }, { status: 400 });
          }
          if (typeof body.title !== 'string' || body.title.trim() === '') {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`title` is required and must be a non-empty string.' } },
              { status: 400 },
            );
          }
          // Shape only: whether the TEXT reads as a rule is `parseRule`'s job, and its message —
          // returned verbatim below — is the only sentence that tells the author what to type
          // instead. This just keeps a non-string off the path that would crash on it.
          if (typeof body.rule !== 'string' || body.rule.trim() === '') {
            return Response.json(
              { error: { code: 'INVALID_RULE', message: '`rule` is required and must be a string.' } },
              { status: 400 },
            );
          }
          if (typeof body.timezone !== 'string' || body.timezone.trim() === '') {
            return Response.json(
              { error: { code: 'INVALID_TIMEZONE', message: '`timezone` is required and must be a string.' } },
              { status: 400 },
            );
          }
          if (body.overlap !== undefined && body.overlap !== 'skip' && body.overlap !== 'allow') {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: `overlap must be "skip" or "allow", not ${JSON.stringify(body.overlap)}` } },
              { status: 400 },
            );
          }
          if (body.stageKey !== undefined && body.stageKey !== null && typeof body.stageKey !== 'string') {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`stageKey` must be a string or null.' } },
              { status: 400 },
            );
          }
          if (body.priority !== undefined && typeof body.priority !== 'number') {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`priority` must be a number.' } },
              { status: 400 },
            );
          }
          if (body.labels !== undefined && (!Array.isArray(body.labels) || body.labels.some((l) => typeof l !== 'string'))) {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`labels` must be an array of strings.' } },
              { status: 400 },
            );
          }
          if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`enabled` must be a boolean.' } },
              { status: 400 },
            );
          }
          // `spec` was the one field here with no shape guard, which reopens exactly the bug the
          // guards above exist for: `board-do.ts` spreads the parsed spec as
          // `{ ...JSON.parse(row.spec_json), scheduleId: id }`, and a string is iterable, so
          // `spec: "urgent"` would spread into `{0:'u',1:'r',...,scheduleId:'sch_…'}` instead of
          // being rejected. Reject a non-object (or null, or an array) here, before it ever reaches
          // that spread.
          if (body.spec !== undefined && (typeof body.spec !== 'object' || body.spec === null || Array.isArray(body.spec))) {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`spec` must be a JSON object.' } },
              { status: 400 },
            );
          }

          const result = await stub.createSchedule({
            title: body.title,
            rule: body.rule,
            // Stored exactly as typed — never `resolvedOptions().timeZone`. See the DO's own note:
            // ICU canonicalises "Asia/Kolkata" to "Asia/Calcutta", so the operator's own spelling is
            // what is kept.
            timezone: body.timezone,
            overlap: (body.overlap as 'skip' | 'allow' | undefined) ?? 'skip',
            createdBy: user!.userId,
            // Same reasoning as `POST /v1/boards/:id/triggers`' `queuedGrant`: creating a schedule
            // IS the act of authorising unattended dispatch, and this is the only moment there is a
            // caller present to record it from. Without it, every card this schedule ever mints
            // falls back to the board's GitHub-webhook grant — which most boards never set — and
            // parks unclaimable under enforcement (whole-branch review, Important 1).
            queuedGrant: user?.mayDispatch ?? null,
            ...(body.stageKey !== undefined ? { stageKey: body.stageKey as string | null } : {}),
            ...(body.priority !== undefined ? { priority: body.priority as number } : {}),
            ...(body.labels !== undefined ? { labels: body.labels as string[] } : {}),
            ...(body.spec !== undefined ? { spec: body.spec } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
          });
          if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
          return Response.json({ schedule: result.value }, { status: 201 });
        }

        if (scheduleId && request.method === 'PATCH') {
          const body = (await request.json().catch(() => null)) as {
            title?: unknown;
            rule?: unknown;
            timezone?: unknown;
            overlap?: unknown;
            stageKey?: unknown;
            priority?: unknown;
            labels?: unknown;
            spec?: JsonValue;
            enabled?: unknown;
          } | null;
          if (!body || typeof body !== 'object') {
            return Response.json({ error: { message: 'Expected a JSON object.' } }, { status: 400 });
          }
          if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim() === '')) {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`title` must be a non-empty string.' } },
              { status: 400 },
            );
          }
          if (body.rule !== undefined && (typeof body.rule !== 'string' || body.rule.trim() === '')) {
            return Response.json(
              { error: { code: 'INVALID_RULE', message: '`rule` must be a string.' } },
              { status: 400 },
            );
          }
          if (body.timezone !== undefined && (typeof body.timezone !== 'string' || body.timezone.trim() === '')) {
            return Response.json(
              { error: { code: 'INVALID_TIMEZONE', message: '`timezone` must be a string.' } },
              { status: 400 },
            );
          }
          if (body.overlap !== undefined && body.overlap !== 'skip' && body.overlap !== 'allow') {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: `overlap must be "skip" or "allow", not ${JSON.stringify(body.overlap)}` } },
              { status: 400 },
            );
          }
          if (body.stageKey !== undefined && body.stageKey !== null && typeof body.stageKey !== 'string') {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`stageKey` must be a string or null.' } },
              { status: 400 },
            );
          }
          if (body.priority !== undefined && typeof body.priority !== 'number') {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`priority` must be a number.' } },
              { status: 400 },
            );
          }
          if (body.labels !== undefined && (!Array.isArray(body.labels) || body.labels.some((l) => typeof l !== 'string'))) {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`labels` must be an array of strings.' } },
              { status: 400 },
            );
          }
          if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`enabled` must be a boolean.' } },
              { status: 400 },
            );
          }
          // Same shape guard as the create route — see its comment.
          if (body.spec !== undefined && (typeof body.spec !== 'object' || body.spec === null || Array.isArray(body.spec))) {
            return Response.json(
              { error: { code: 'INVALID_SCHEDULE', message: '`spec` must be a JSON object.' } },
              { status: 400 },
            );
          }

          const result = await stub.updateSchedule(scheduleId, {
            ...(body.title !== undefined ? { title: body.title as string } : {}),
            ...(body.rule !== undefined ? { rule: body.rule as string } : {}),
            ...(body.timezone !== undefined ? { timezone: body.timezone as string } : {}),
            ...(body.overlap !== undefined ? { overlap: body.overlap as 'skip' | 'allow' } : {}),
            ...(body.stageKey !== undefined ? { stageKey: body.stageKey as string | null } : {}),
            ...(body.priority !== undefined ? { priority: body.priority as number } : {}),
            ...(body.labels !== undefined ? { labels: body.labels as string[] } : {}),
            ...(body.spec !== undefined ? { spec: body.spec } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
          });
          if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
          return Response.json({ schedule: result.value });
        }

        if (scheduleId && request.method === 'DELETE') {
          const result = await stub.deleteSchedule(scheduleId);
          if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
          return new Response(null, { status: 204 });
        }

        return Response.json({ error: 'method not allowed' }, { status: 405 });
      }

      // POST /v1/boards/:id/push-configs — register an agent push subscription (docs/05 §4)
      if (rest === 'push-configs' && request.method === 'POST') {
        // An agent token subscribes the agent it authenticates — never the one a header names. A
        // person (session cookie or dev headers) still names the subscriber with `X-Agent-Id`.
        const agentId = agent ? agent.agentId : request.headers.get('X-Agent-Id');
        if (!agentId || agentId.trim() === '') return Response.json({ error: 'X-Agent-Id required' }, { status: 400 });
        const body = (await request.json()) as { url: string; token: string; capabilities?: string[]; events?: string[] };
        // Built from named fields rather than `...body`: `agentId` is the caller's own identity,
        // asserted by the `X-Agent-Id` header above — `as` strips nothing at runtime, so a body
        // `agentId` would otherwise win over the header for this call (it did, before this fix: a
        // caller could register the subscription under any agent id it liked while authenticating
        // as a different one). A cast is not validation, so the route has to name what it accepts
        // rather than forward what it received.
        const result = await stub.registerPushConfig({
          agentId,
          url: body.url,
          token: body.token,
          capabilities: body.capabilities,
          events: body.events,
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value, { status: 201 });
      }

      // POST /v1/boards/:id/push/dispatch — drain the delivery queue (cron/admin) (docs/05 §4)
      if (rest === 'push/dispatch' && request.method === 'POST') {
        return Response.json(await stub.dispatchPushDeliveries());
      }

      // GET /v1/boards/:id/push/deliveries — inspect the delivery queue (docs/05 §4)
      if (rest === 'push/deliveries' && request.method === 'GET') {
        return Response.json({ deliveries: await stub.getPushDeliveries() });
      }

      // PUT /v1/boards/:id/budget — set/clear USD budget caps (docs/07 §6)
      if (rest === 'budget' && request.method === 'PUT') {
        const body = (await request.json()) as { boardUsdCap?: number | null; cardUsdCap?: number | null };
        // Built from named fields rather than forwarding `body` whole, same as the other PUT/POST
        // routes in this file: the cast strips nothing at runtime.
        const result = await stub.setBudget({ boardUsdCap: body.boardUsdCap, cardUsdCap: body.cardUsdCap });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value);
      }

      // PUT /v1/boards/:id/github — configure GitHub: webhook secret + issue→card trigger (docs/06 §3, docs/05 §6)
      if (rest === 'github' && request.method === 'PUT') {
        const body = (await request.json()) as { secret?: string; issueTrigger?: boolean };
        // Wiring a repository to a board IS the act of authorising automated
        // dispatch from it, so the grant the operator holds at that moment is
        // recorded with the configuration. A webhook fires with nobody present;
        // without this the card it creates carries no authority and can never be
        // claimed under enforcement.
        //
        // Re-sent on every config write, deliberately: the grant is only as good
        // as the last person who confirmed it, and re-saving the settings is how
        // an operator refreshes it after their own permissions change.
        // Built from named fields rather than `{ ...body, triggerGrant }`: the spread came BEFORE
        // `triggerGrant`, so that field already wins today, but the cast above does not stop a
        // body from carrying other keys `setGithubConfig` happens to read — safe only because its
        // input type coincides with this one.
        const result = await stub.setGithubConfig({
          secret: body.secret,
          issueTrigger: body.issueTrigger,
          triggerGrant: user?.mayDispatch ?? null,
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value);
      }

      // POST /v1/boards/:id/triggers — generic inbound trigger → one createCard path (docs/05 §6)
      if (rest === 'triggers' && request.method === 'POST') {
        const body = (await request.json()) as {
          title: string;
          ownerUserId?: string;
          spec?: JsonValue;
          source?: { url: string; provider?: string; sourceType?: string; externalId?: string; title?: string; metadata?: JsonValue };
        };
        const result = await stub.createCardFromTrigger({
          title: body.title,
          ownerUserId: body.ownerUserId ?? user?.userId ?? 'usr_trigger',
          spec: body.spec,
          // This route DOES have a caller, unlike the webhook — so the grant
          // comes from them, and the board's standing grant is only the
          // fallback for when it doesn't.
          queuedGrant: user?.mayDispatch ?? null,
          source: body.source,
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value, { status: 201 });
      }

      // PUT /v1/boards/:id/forge — this board's forge webhook secret.
      //
      // Separate from `PUT …/github` and holding its own secret: a board may legitimately receive
      // from a forge-primary repository AND its GitHub mirror, and one shared secret would mean
      // revoking either side's access revokes the other's.
      if (rest === 'forge' && request.method === 'PUT') {
        const body = (await request.json().catch(() => null)) as { secret?: string } | null;
        if (!body || typeof body.secret !== 'string' || body.secret.trim() === '') {
          return Response.json({ error: 'secret is required' }, { status: 400 });
        }
        const result = await stub.setForgeSecret(body.secret);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value);
      }

      // POST /v1/boards/:id/webhooks/forge — inbound Forgejo webhook.
      //
      // Forgejo sends its own `X-Forgejo-*` headers and, for compatibility, GitHub-spelled ones
      // too. The event and delivery are read from either, because a Gitea-typed webhook on an
      // older instance sends `X-Gitea-*` and both are the same claim. The SIGNATURE is read only
      // from Forgejo's own header: accepting `X-Hub-Signature-256` here would let a payload
      // signed for the GitHub door in through this one.
      if (rest === 'webhooks/forge' && request.method === 'POST') {
        const rawBody = await request.text();
        const header = (...names: string[]): string | null => {
          for (const n of names) {
            const v = request.headers.get(n);
            if (v) return v;
          }
          return null;
        };
        const result = await stub.handleForgeWebhook({
          rawBody,
          signature: header('X-Forgejo-Signature', 'X-Gitea-Signature'),
          deliveryId: header('X-Forgejo-Delivery', 'X-Gitea-Delivery', 'X-GitHub-Delivery'),
          event: header('X-Forgejo-Event', 'X-Gitea-Event', 'X-GitHub-Event') ?? '',
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value);
      }

      // POST /v1/boards/:id/webhooks/github — inbound GitHub webhook (docs/06 §3).
      // GitHub can't send X-Tenant-Id, so the configured webhook URL carries ?tenant=; the HMAC
      // signature (verified in the DO) is the real authentication.
      if (rest === 'webhooks/github' && request.method === 'POST') {
        const rawBody = await request.text();
        const result = await stub.handleGithubWebhook({
          rawBody,
          signature: request.headers.get('X-Hub-Signature-256'),
          deliveryId: request.headers.get('X-GitHub-Delivery'),
          event: request.headers.get('X-GitHub-Event') ?? '',
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value);
      }

      // POST /v1/boards/:id/claims — an agent claims a ready card (docs/04 §3). Identity + capabilities
      // come from the agent's token; the request body only carries concurrency/profile (and, in dev,
      // the capabilities since the dev headers don't encode them).
      if (rest === 'claims' && request.method === 'POST') {
        if (!agent!.agentId) return Response.json({ error: 'an agent identity is required to claim' }, { status: 400 });
        const input: unknown = await request.json().catch(() => null);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          return Response.json({ error: 'claim body must be a JSON object' }, { status: 400 });
        }
        const payload = input as { capabilities?: unknown; maxConcurrency?: unknown; profileKey?: unknown };
        if (payload.maxConcurrency !== undefined &&
            (typeof payload.maxConcurrency !== 'number' || !Number.isInteger(payload.maxConcurrency) || payload.maxConcurrency <= 0)) {
          return Response.json({ error: 'maxConcurrency must be a positive finite integer' }, { status: 400 });
        }
        if (payload.capabilities !== undefined &&
            (!Array.isArray(payload.capabilities) || !payload.capabilities.every((cap): cap is string => typeof cap === 'string'))) {
          return Response.json({ error: 'capabilities must be an array of strings' }, { status: 400 });
        }
        if (payload.profileKey !== undefined && typeof payload.profileKey !== 'string') {
          return Response.json({ error: 'profileKey must be a string' }, { status: 400 });
        }
        // Declared → effective. An agent staffed for `code-review` claims a `code` lane when the
        // workspace has said one implies the other. The expansion happens HERE, at the Worker
        // boundary, because the edges live in the catalog and the Durable Object has no D1: the
        // DO keeps matching a flat set and stays ignorant of where it came from.
        const declared = agent!.capabilities ?? payload.capabilities ?? [];
        const claimResult = await stub.claim({
          agentId: agent!.agentId,
          capabilities: await effectiveCapabilities(env.DB, agent!.tenantId, declared),
          // `agents.concurrency` has existed since migration 0001 and was read by nothing. It is
          // the operator's ceiling, so an agent may ask for LESS than it (a node that knows it is
          // busy) but never for more: the request is a preference, the column is the permission.
          maxConcurrency:
            payload.maxConcurrency !== undefined && agent!.concurrency !== undefined
              ? Math.min(payload.maxConcurrency, agent!.concurrency)
              : (payload.maxConcurrency ?? agent!.concurrency),
          profileKey: payload.profileKey,
          principalId: agent!.externalId,
        });
        return Response.json(claimResult);
      }

      // GET /v1/boards/:id/runs/:runId — the agent read surface (docs/04 §3 `getCard`): the card
      // this run holds, its stage, the upstream handoff and the card's references. Scoped to the
      // agent that claimed the run — a shared board is not readable through an agent token.
      const runReadMatch = rest.match(/^runs\/([^/]+)$/);
      if (runReadMatch && request.method === 'GET') {
        const result = await stub.getRunContext({ runId: runReadMatch[1]!, agentId: agent!.agentId });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value);
      }

      // POST /v1/boards/:id/runs/:runId/:action — agent run verbs (docs/04 §3)
      const runMatch = rest.match(/^runs\/([^/]+)\/([^/]+)$/);
      if (runMatch && request.method === 'POST') {
        const runId = runMatch[1]!;
        const action = runMatch[2]!;
        const p = (await request.json()) as {
          leaseEpoch: number;
          type?: AgentActivityType;
          ephemeral?: boolean;
          body?: string;
          action?: string;
          parameter?: JsonValue;
          result?: JsonValue;
          signal?: string;
          handoff?: JsonValue;
          output?: JsonValue;
          reason?: string;
          usage?: { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number };
        };
        const respond = (r: Result<unknown>, key: string): Response =>
          r.ok
            ? Response.json({ [key]: r.value })
            : Response.json({ error: r }, { status: statusForCode(r.code) });

        // The lease says the run is current; `agentId` says it is *yours*. It is the principal the
        // token resolved to, never a client-asserted value (docs/04 §1).
        const lease = { runId, leaseEpoch: p.leaseEpoch, agentId: agent!.agentId };

        switch (action) {
          case 'heartbeat':
            return respond(await stub.heartbeat(lease), 'run');
          case 'activities':
            return respond(
              await stub.postActivity({
                ...lease,
                type: p.type ?? 'thought',
                ephemeral: p.ephemeral,
                body: p.body,
                action: p.action,
                parameter: p.parameter,
                result: p.result,
                signal: p.signal,
                usage: p.usage,
              }),
              'activity',
            );
          case 'complete':
            return respond(await stub.complete({ ...lease, handoff: p.handoff }), 'card');
          case 'block':
            return respond(await stub.block({ ...lease, reason: p.reason ?? '' }), 'card');
          case 'fail':
            return respond(await stub.fail({ ...lease, reason: p.reason ?? '' }), 'card');
          case 'release':
            return respond(await stub.release(lease), 'card');
          case 'submit':
            return respond(await stub.submitForReview({ ...lease, output: p.output }), 'card');
          default:
            return Response.json({ error: `unknown run action: ${action}` }, { status: 404 });
        }
      }

      // GET /v1/boards/:id/gates/pending — every gate still waiting on a human.
      //
      // The read half of the hub's reconciliation sweep (`charter →
      // decisions/2026-08-30-a-gate-closes-over-chat.md` §5). Push carries a
      // gate when it opens and dead-letters after five attempts; this is how a
      // gate that was never delivered is found rather than waited for.
      if (rest === 'gates/pending' && request.method === 'GET') {
        return Response.json({ gates: await stub.pendingGateDeliveries() });
      }

      // GET /v1/boards/:id/gates/:gateId — one gate, including how it was decided.
      const oneGate = rest.match(/^gates\/([^/]+)$/);
      if (oneGate && request.method === 'GET') {
        const result = await stub.getGate(oneGate[1]!);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ gate: result.value });
      }

      // POST /v1/boards/:id/gates/:gateId/resolve — the signed-in human resolves an approval gate (docs/08 §6)
      const gateMatch = rest.match(/^gates\/([^/]+)\/resolve$/);
      if (gateMatch && request.method === 'POST') {
        const gp = (await request.json()) as { decision: GateDecision; comment?: string };
        const result = await stub.resolveGate({
          gateId: gateMatch[1]!,
          decision: gp.decision,
          decidedBy: user?.userId ?? 'usr_dev',
          comment: gp.comment,
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ card: result.value });
      }

      // GET /v1/boards/:id/elicitations/pending — every question still waiting on a human.
      //
      // The read half of a projection's reconciliation sweep, and the mirror of
      // `gates/pending` above. Push carries a question when it opens and dead-letters
      // after five attempts; this is how a question that was never delivered is found
      // rather than waited for.
      //
      // It also carries a meaning the gate version does not need as badly: a question is
      // retired by the next question on the same card, so ABSENCE from this list is how a
      // reader learns that a question it already showed can no longer be answered.
      //
      // Matched before the answer route below, which it cannot collide with — that one
      // ends in `/answer` — but kept adjacent so the pair reads together.
      if (rest === 'elicitations/pending' && request.method === 'GET') {
        return Response.json({ elicitations: await stub.pendingElicitationDeliveries() });
      }

      // POST /v1/boards/:id/elicitations/:elicitationId/answer — the signed-in human answers an
      // agent's question (docs/04 §4), which returns the card to `working` and unblocks the agent.
      //
      // Deliberately a *human* route: agent tokens authenticate `claims` and `runs/*` only, so an
      // agent cannot reach this at all — and the DO refuses the asking agent's identity besides, so
      // the rule holds on every surface rather than only at this door.
      const answerMatch = rest.match(/^elicitations\/([^/]+)\/answer$/);
      if (answerMatch && request.method === 'POST') {
        const ap = (await request.json()) as { option?: string; text?: string };
        const result = await stub.answerElicitation({
          elicitationId: answerMatch[1]!,
          answeredBy: user?.userId ?? 'usr_dev',
          option: ap.option,
          text: ap.text,
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value);
      }

      return Response.json({ error: 'method not allowed' }, { status: 405 });
    } catch (err) {
      return unexpected(err);
    }
  },

  /**
   * Drain every board's push delivery queue and superwitness run-report outbox.
   *
   * `POST /v1/boards/:id/push/dispatch` has always existed and nothing ever called it on a
   * schedule: the queue drained only on a DO alarm or when somebody POSTed by hand, so a delivery
   * whose alarm was missed sat there indefinitely. A queue with no drain is a queue that loses
   * things quietly.
   *
   * Best-effort per board, and deliberately so: one board whose DO throws must not stop the sweep
   * for every other board in the deployment.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        for (const board of await listAllBoards(env.DB)) {
          try {
            await boardStub(env, board.tenantId, board.id).dispatchPushDeliveries();
          } catch {
            /* one board's failure is not the sweep's */
          }
          try {
            await boardStub(env, board.tenantId, board.id).sweepBoard(new Date().toISOString());
          } catch (err) {
            // A failing sweep on one board must not stop the rest of the loop — but swallowing it
            // silently meant a board failing every five-minute tick, forever, left no trace
            // anywhere. Logged, not rethrown: the loop still continues to the next board.
            console.error(`sweepBoard failed for board ${board.id}`, err);
          }
          // The superwitness outbox's backstop (superwitness app spec §3.5): the board alarm is the
          // drain; this catches a board whose alarm was lost. Due rows only — backoff still holds.
          try {
            await boardStub(env, board.tenantId, board.id).drainRunReports();
          } catch {
            logReporter('error', { msg: 'superwitness.sweep_failed', 'board.id': board.id });
          }
        }
        // Third arm, same shape as the two above: every project's rollup (Task 19), refreshed so
        // `GET /v1/projects/:id/rollup` almost never has to pay for the fan-out itself — the 60s
        // cache window is usually already warm by the time anyone asks. `computeRollup` is itself
        // forgiving of a board that fails to answer (`partial`/`boardsUnanswered`); this try/catch
        // is only for a failure in computeRollup's OWN bookkeeping (e.g. the D1 write that caches
        // the row), logged rather than swallowed for the same reason the sweep above is.
        for (const project of await listAllProjects(env.DB)) {
          try {
            await computeRollup(env.DB, env, project.tenantId, project.id);
          } catch (err) {
            console.error(`computeRollup failed for project ${project.id}`, err);
          }
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

export default {
  fetch: (request: Request, env: Env): Promise<Response> => withRunTelemetry(request, () => worker.fetch(request, env)),
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> =>
    worker.scheduled(event, env, ctx),
} satisfies ExportedHandler<Env>;

/**
 * Kaambaan API — the edge Worker (docs/02-architecture.md). It authenticates, resolves the tenant,
 * and routes board requests to the per-(tenant, board) Board Durable Object, serving the SvelteKit
 * SPA same-origin for everything else.
 *
 * Auth (docs/05 §3). Three principals, resolved before dispatch:
 *   - humans      — a signed `kaambaan_session` cookie from GitHub OAuth (auth/routes.ts). Stateless
 *                   HMAC, no session store. This is what board/card administration requires.
 *   - agents      — a `kbn_` bearer on the agent routes only: `…/claims` and `…/runs/*`. The tenant
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
  type BoardSnapshot,
  type BoardErrorCode,
  type AgentActivityType,
  type GateDecision,
  type Result,
  type JsonValue,
} from './board/board-do';
import type { Env } from './env';
import { newId } from './ids';
import { boardStub } from './board/stub';
import { resolveReferenceInput } from './references/resolve';
import { handleMcpRequest } from './mcp/server';
import { resolveMcpAuth, unauthorized, protectedResourceMetadata, MCP_PROTECTED_RESOURCE_PATH } from './mcp/auth';
import { resolveUser, resolveAgent, type UserPrincipal, type AgentPrincipal, resolveHubUser, resolveHubAgent } from './auth/resolve';
import { handleAuthRoute } from './auth/routes';
import { handleHubRoute } from './auth/hub-oauth';
import { recordBoard, listBoards, listAllBoards, renameBoard, updateBoardStages, deleteBoard, listAgents, createAgent, updateAgent, createAgentToken, revokeAgentToken, deleteAgent, setAgentExternalMapping, findAgentByExternal, agentBelongsToTenant, setTenantExternalMapping, tenantById } from './db/catalog';
import { AGENT_TOKEN_SCOPES, requiredScope, scopePermits } from './auth/scopes';
import { capabilityTag, capabilityTags } from '@kaambaan/contract';
import { listMembers, addMember, setMemberRole, removeMember, ownerCount, permits, asRole, type Capability } from './db/members';
import {
  listCapabilities,
  createCapability,
  updateCapability,
  deleteCapability,
  capabilityById,
  capabilityUsage,
  ensureCapabilities,
} from './db/capabilities';

export { BoardDO };

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
  const keys = stages.filter((s) => s.ownerKind === 'capability' && s.owner).map((s) => s.owner!);
  if (keys.length > 0) await ensureCapabilities(env.DB, tenantId, keys, createdBy);
}

function unexpected(err: unknown): Response {
  const message = (err as { message?: string })?.message ?? 'unexpected error';
  return Response.json({ error: { message } }, { status: 500 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/health') {
      return Response.json({ ok: true, service: 'kaambaan-api', phase: 'P8' });
    }

    // Human auth (GitHub OAuth → session): /auth/login · /auth/callback · /auth/me · /auth/logout.
    if (path.startsWith('/auth/')) {
      const res = await handleAuthRoute(request, env, path);
      if (res) return res;
    }

    // The hub token handoff: /hub/connect · /hub/callback · /hub/token (auth/hub-oauth.ts).
    //
    // Not part of `/auth/*` above, deliberately. Those routes establish who you are HERE — a
    // kaambaan session, from GitHub. These carry authority from somewhere else: the hub is the
    // issuer, kaambaan is not, and nothing under this prefix creates or reads a kaambaan session.
    // The separate prefix is also what `run_worker_first` in wrangler.jsonc names, so the SPA's
    // index.html fallback cannot shadow a callback the hub redirected a browser to.
    if (path.startsWith('/hub/')) {
      const res = await handleHubRoute(request, env, path);
      if (res) return res;
    }

    // MCP surface (docs/05 §2): an OAuth Resource Server in front of the Streamable HTTP endpoint.
    if (request.method === 'GET' && path === MCP_PROTECTED_RESOURCE_PATH) {
      return protectedResourceMetadata(request);
    }
    if (path === '/mcp') {
      const auth = await resolveMcpAuth(request, env);
      if (!auth) return unauthorized(request);
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
    // cookie or dev headers, never a `kbn_` bearer and never a hub token. Linking a plane is at
    // least as consequential as revoking a credential (charter
    // decisions/2026-08-13-ecosystem-identity.md Decision 3), and the hub-token path could not
    // work here anyway: `resolveHubUser` needs this mapping to already exist, so a token can
    // never establish the mapping that makes that token resolve. It is human-only or it is
    // unreachable.
    //
    // Scoped to owners. The comment this replaces recorded the absence of that check as "a
    // decision about the whole product rather than about this endpoint" — the decision is now
    // made, in db/members.ts, and every route reads it from the same place.
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
        // unique. kaambaan is one-tenant-per-user, so two people in the same real organisation
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
    const capsMatch = path.match(/^\/v1\/capabilities(?:\/([^/]+))?$/);
    if (capsMatch) {
      try {
        const u = await resolveUser(request, env);
        if (!u) return Response.json({ error: 'sign in to continue' }, { status: 401 });
        const capId = capsMatch[1];

        if (request.method === 'GET' && !capId) {
          // A read: anyone who can see the board needs to know what its lanes ask for.
          const refused = refuseByRole(u, 'read');
          if (refused) return refused;
          return Response.json({ capabilities: await listCapabilities(env.DB, u.tenantId) });
        }

        // Defining the workspace's vocabulary is the same class of act as managing its agents.
        const refused = refuseByRole(u, 'manage');
        if (refused) return refused;

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
          const made = await createCapability(env.DB, u.tenantId, { ...body, key: body.key, createdBy: u.userId });
          if (!made) {
            // A collision reads as a sentence rather than a raw UNIQUE failure — and re-declaring
            // an existing capability is a rename, which `PATCH` does.
            return Response.json({ error: `${capabilityTag(body.key)} already exists in this workspace` }, { status: 409 });
          }
          return Response.json({ capability: made }, { status: 201 });
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
          if (!(await updateCapability(env.DB, u.tenantId, capId, body))) {
            return Response.json({ error: 'capability not found, or nothing to change' }, { status: 404 });
          }
          return Response.json({ capability: await capabilityById(env.DB, u.tenantId, capId) });
        }

        if (capId && request.method === 'DELETE') {
          const cap = await capabilityById(env.DB, u.tenantId, capId);
          if (!cap) return Response.json({ error: 'capability not found' }, { status: 404 });
          // Removing one that is still named would silently stop the registry describing the
          // product: the strings stay on the stage and the agent, matching carries on, and the
          // list quietly goes wrong. So the refusal names who still refers to it.
          const used = await capabilityUsage(env.DB, u.tenantId, cap.key);
          if (used.agents.length > 0 || used.boards.length > 0) {
            const who = [
              used.boards.length > 0 ? `boards ${used.boards.join(', ')}` : null,
              used.agents.length > 0 ? `agents ${used.agents.join(', ')}` : null,
            ].filter(Boolean).join(' and ');
            return Response.json({ error: `${cap.key} is still used by ${who}`, usage: used }, { status: 409 });
          }
          await deleteCapability(env.DB, u.tenantId, capId);
          return new Response(null, { status: 204 });
        }

        return Response.json({ error: 'method not allowed' }, { status: 405 });
      } catch (err) {
        return unexpected(err);
      }
    }

    // /v1/agents[/:id[/tokens/:tokenId]] — a workspace's agents + token minting (the "connect an
    // agent" surface) + token revocation, right beside it. The plaintext token is returned ONCE
    // on create; thereafter only its hash is stored, and revoking sets `revoked_at` on that row —
    // `findAgentByTokenHash` already refuses anything revoked (catalog.ts), so this write is the
    // whole mechanism.
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
        // Read-only, and only as a FALLBACK: the session cookie and `kbn_` token
        // paths are untouched and still take precedence, so nothing that works
        // today changes. The hub token is verified offline against a cached JWKS —
        // no network call in this path — and resolves to the same principal shape,
        // so nothing downstream can tell which credential arrived.
        //
        // Deliberately not extended to POST or DELETE yet: proving the contract
        // needs a read, and a first integration should not also be the first
        // credential able to mint an agent token.
        let u = await resolveUser(request, env);
        if (!u && request.method === 'GET') u = await resolveHubUser(request, env);
        if (!u) return Response.json({ error: 'sign in to continue' }, { status: 401 });
        const agentId = agentsMatch[1];
        const tokenId = agentsMatch[3];
        const mintingTokens = agentId && agentsMatch[2] === 'tokens' && !tokenId;

        // POST /v1/agents/:id/tokens — issue a fresh `kbn_` for an agent that already exists.
        //
        // Without this, revoking an agent's last token was terminal: tokens were only ever minted
        // inside `POST /v1/agents`, so "cannot authenticate until reconnected" named a reconnect
        // that did not exist, and a linked agent — which is created with no `kbn_` at all — could
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
          const minted = await createAgentToken(env.DB, u.tenantId, agentId, AGENT_TOKEN_SCOPES);
          return Response.json({ token: minted.token, tokenId: minted.id }, { status: 201 });
        }

        if (agentId && tokenId) {
          // Revoking a credential is a HUMAN act, same as minting one: `u` above came ONLY from
          // `resolveUser` (session cookie or dev headers) — never from a `kbn_` bearer or a hub
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
            };

            // The agent's OWN properties, which until now could be set exactly once — in the
            // INSERT inside `createAgent` — and changed nowhere. An agent staffed with the wrong
            // capabilities could not be restaffed; the only remedy was to delete it and make
            // another, which for a linked agent discards its principal link too.
            //
            // Handled before the externalId branch, and independently of it: linking a principal
            // and editing an agent are different acts that happen to share a route, and a PATCH
            // carrying only `capabilities` must not be refused for want of an `externalId`.
            const patch: { name?: string; capabilities?: string[]; iconUrl?: string | null; concurrency?: number } = {};
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
            if (Object.keys(patch).length > 0) await updateAgent(env.DB, u.tenantId, agentId, patch);

            if (body.externalId === undefined) {
              // A patch that only touched the agent's own fields is complete. Only a request that
              // named NOTHING at all is a mistake worth reporting.
              if (Object.keys(patch).length > 0) return Response.json({ ok: true });
              return Response.json({ error: 'nothing to change: send name, capabilities, iconUrl, concurrency, or externalId' }, { status: 400 });
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
             * kaambaan has no principals to name, and an agent nobody links is
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
            // No `kbn_` token. A linked agent authenticates with hub JWTs
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

    // Resolve the caller by route type: agent routes carry a token; the GitHub webhook
    // self-authenticates (HMAC) and carries ?tenant=; everything else is a human (session cookie).
    // `gates/pending` joins `claims` and `runs/*` as an agent route. It is a
    // read that names nobody and carries no authority — the widening is one
    // GET, not the surface. The alternative was for agentpod's bridge to mint
    // an assertion for a human on a timer so it could use the human-routed
    // board snapshot, which would make "a service may speak as a person" a
    // background job rather than the carrying of an answer that person gave.
    const isAgentRoute =
      !!boardId && (rest === 'claims' || rest.startsWith('runs/') || rest === 'gates/pending');
    const isWebhook = !!boardId && rest === 'webhooks/github';
    let tenantId: string;
    let user: UserPrincipal | null = null;
    let agent: AgentPrincipal | null = null;

    if (isWebhook) {
      const t = url.searchParams.get('tenant');
      if (!t || t.trim() === '') return Response.json({ error: 'tenant required' }, { status: 400 });
      tenantId = t;
    } else if (isAgentRoute) {
      agent = await resolveAgent(request, env);
      // Mirrors the human fallback below: a node can now exchange its own credential for a
      // short-lived hub token whose sub is an agent principal, and kaambaan must accept it as
      // that agent — capabilities still come from kaambaan's own agents row, never the claim.
      if (!agent) agent = await resolveHubAgent(request, env);
      if (!agent) return Response.json({ error: 'a valid agent token is required' }, { status: 401 });
      // Scopes stop being decoration here. Every `kbn_` token has carried a scope set since
      // migration 0001, the resolver has always returned it, and nothing compared it to the action
      // being attempted — so a token minted to claim drove every run verb. A recorded permission
      // nobody checks reads as protection that does not exist (auth/scopes.ts).
      const needed = requiredScope(rest);
      if (needed && !scopePermits(agent.scopes, needed)) {
        return Response.json({ error: `this token is not permitted to ${needed}` }, { status: 403 });
      }
      tenantId = agent.tenantId;
    } else {
      user = await resolveUser(request, env);
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
          : rest === '' || rest === 'stages' || rest === 'github' || rest === 'budget' || rest === 'profiles'
            ? 'manage'
            : 'work';
      const refusedByRole = refuseByRole(user, needed);
      if (refusedByRole) return refusedByRole;
      tenantId = user.tenantId;
    }

    try {
      // GET /v1/boards — list the workspace's boards · POST /v1/boards — create one
      if (!boardId) {
        if (request.method === 'GET') return Response.json({ boards: await listBoards(env.DB, tenantId) });
        if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
        const body = (await request.json()) as { name: string; stages: StageDef[] };
        const id = newId('brd');
        const snapshot = await boardStub(env, tenantId, id).init({ id, tenantId, name: body.name, stages: body.stages });
        await recordBoard(env.DB, tenantId, { id, name: body.name, stagesJson: JSON.stringify(snapshot.stages) });
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
        };
        // The authority that accompanied the act, recorded with the card. A
        // session-cookie caller carries none, and `undefined` there means "no
        // one with permission asked for this to run" — which is refused under
        // enforcement rather than treated as an empty grant.
        const result = await stub.createCard({
          ...body,
          ownerUserId: body.ownerUserId ?? user?.userId ?? 'usr_dev',
          queuedGrant: user?.mayDispatch ?? null,
        });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
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
        const result = await stub.moveCard(moveMatch[1]!, body.toStageKey, user!.userId, user!.mayDispatch ?? null);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ card: result.value });
      }

      // PATCH /v1/boards/:id/cards/:cardId — edit a card · DELETE — remove it
      const cardMatch = rest.match(/^cards\/([^/]+)$/);
      if (cardMatch && request.method === 'PATCH') {
        const body = (await request.json()) as { title?: string; spec?: JsonValue; priority?: number; ownerUserId?: string };
        if (body.ownerUserId !== undefined && (typeof body.ownerUserId !== 'string' || body.ownerUserId.trim() === '')) {
          return Response.json({ error: 'ownerUserId must be a non-empty user id' }, { status: 400 });
        }
        const result = await stub.updateCard(cardMatch[1]!, body);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ card: result.value });
      }
      if (cardMatch && request.method === 'DELETE') {
        const result = await stub.deleteCard(cardMatch[1]!);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return new Response(null, { status: 204 });
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
        const result = await stub.addReference(resolveReferenceInput({ cardId: refMatch[1]!, ...body }));
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
        const result = await stub.setProfile(body);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json(result.value, { status: 201 });
      }

      // POST /v1/boards/:id/push-configs — register an agent push subscription (docs/05 §4)
      if (rest === 'push-configs' && request.method === 'POST') {
        const agentId = request.headers.get('X-Agent-Id');
        if (!agentId || agentId.trim() === '') return Response.json({ error: 'X-Agent-Id required' }, { status: 400 });
        const body = (await request.json()) as { url: string; token: string; capabilities?: string[]; events?: string[] };
        const result = await stub.registerPushConfig({ agentId, ...body });
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
        const result = await stub.setBudget(body);
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
        const result = await stub.setGithubConfig({ ...body, triggerGrant: user?.mayDispatch ?? null });
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
        const payload = (await request.json()) as { capabilities?: string[]; maxConcurrency?: number; profileKey?: string };
        const claimResult = await stub.claim({
          agentId: agent!.agentId,
          capabilities: agent!.capabilities ?? payload.capabilities ?? [],
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
   * Drain every board's push delivery queue.
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
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

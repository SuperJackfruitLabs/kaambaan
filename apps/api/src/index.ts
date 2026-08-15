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
 * `role` and token `scopes` are stored but not enforced anywhere — membership in the tenant is the
 * granularity of human authorization today.
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
import { resolveUser, resolveAgent, type UserPrincipal, type AgentPrincipal, resolveHubUser } from './auth/resolve';
import { handleAuthRoute } from './auth/routes';
import { recordBoard, listBoards, renameBoard, deleteBoard, listAgents, createAgent, createAgentToken, deleteAgent } from './db/catalog';

export { BoardDO };

function statusForCode(code: BoardErrorCode): number {
  switch (code) {
    case 'WIP_LIMIT':
      return 409;
    case 'UNKNOWN_STAGE':
    case 'INVALID_URL':
    case 'INVALID_DELIVERY':
    case 'INVALID_USAGE':
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

    // MCP surface (docs/05 §2): an OAuth Resource Server in front of the Streamable HTTP endpoint.
    if (request.method === 'GET' && path === MCP_PROTECTED_RESOURCE_PATH) {
      return protectedResourceMetadata(request);
    }
    if (path === '/mcp') {
      const auth = await resolveMcpAuth(request, env);
      if (!auth) return unauthorized(request);
      return handleMcpRequest(request, env, auth);
    }

    // /v1/agents[/:id] — a workspace's agents + token minting (the "connect an agent" surface). The
    // plaintext token is returned ONCE on create; thereafter only its hash is stored.
    const agentsMatch = path.match(/^\/v1\/agents(?:\/([^/]+))?$/);
    if (agentsMatch) {
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
      if (agentId) {
        if (request.method === 'DELETE') {
          await deleteAgent(env.DB, u.tenantId, agentId);
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: 'method not allowed' }, { status: 405 });
      }
      if (request.method === 'GET') return Response.json({ agents: await listAgents(env.DB, u.tenantId) });
      if (request.method === 'POST') {
        const body = (await request.json()) as { name?: string; capabilities?: string[] };
        if (!body.name || body.name.trim() === '') return Response.json({ error: 'name is required' }, { status: 400 });
        const created = await createAgent(env.DB, u.tenantId, { name: body.name.trim(), capabilities: body.capabilities ?? [] });
        const { token } = await createAgentToken(env.DB, u.tenantId, created.id, ['claim']);
        return Response.json({ agent: created, token }, { status: 201 });
      }
      return Response.json({ error: 'method not allowed' }, { status: 405 });
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
    const isAgentRoute = !!boardId && (rest === 'claims' || rest.startsWith('runs/'));
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
      if (!agent) return Response.json({ error: 'a valid agent token is required' }, { status: 401 });
      tenantId = agent.tenantId;
    } else {
      user = await resolveUser(request, env);
      if (!user) return Response.json({ error: 'sign in to continue' }, { status: 401 });
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
        await recordBoard(env.DB, tenantId, { id, name: body.name, stagesJson: JSON.stringify(body.stages) });
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

      // DELETE /v1/boards/:id — remove the board from the workspace (catalog entry)
      if (rest === '' && request.method === 'DELETE') {
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
        const result = await stub.createCard({ ...body, ownerUserId: body.ownerUserId ?? user?.userId ?? 'usr_dev' });
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ card: result.value }, { status: 201 });
      }

      // POST /v1/boards/:id/cards/:cardId/move — move a card
      const moveMatch = rest.match(/^cards\/([^/]+)\/move$/);
      if (moveMatch && request.method === 'POST') {
        const body = (await request.json()) as { toStageKey: string };
        const result = await stub.moveCard(moveMatch[1]!, body.toStageKey);
        if (!result.ok) return Response.json({ error: result }, { status: statusForCode(result.code) });
        return Response.json({ card: result.value });
      }

      // PATCH /v1/boards/:id/cards/:cardId — edit a card · DELETE — remove it
      const cardMatch = rest.match(/^cards\/([^/]+)$/);
      if (cardMatch && request.method === 'PATCH') {
        const body = (await request.json()) as { title?: string; spec?: JsonValue; priority?: number };
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

      // GET /v1/boards/:id/usage — cost/usage rollup (docs/07 §6). `?window=` filters to a recent span.
      if (rest === 'usage' && request.method === 'GET') {
        const window = url.searchParams.get('window');
        return Response.json(await stub.getUsage(window ? { window } : undefined));
      }

      // GET /v1/boards/:id/notifications — in-app notification feed (docs/07 §7)
      if (rest === 'notifications' && request.method === 'GET') {
        const unreadOnly = url.searchParams.get('unread') === 'true';
        return Response.json({ notifications: await stub.getNotifications({ unreadOnly }) });
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
        const result = await stub.setGithubConfig(body);
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
        const result = await stub.createCardFromTrigger({ title: body.title, ownerUserId: body.ownerUserId ?? user?.userId ?? 'usr_trigger', spec: body.spec, source: body.source });
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
          maxConcurrency: payload.maxConcurrency,
          profileKey: payload.profileKey,
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
      const message = (err as { message?: string })?.message ?? 'unexpected error';
      return Response.json({ error: { message } }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

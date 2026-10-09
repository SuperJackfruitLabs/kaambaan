import type { Env } from './env';
import { CARDS_READ, PUSH_WRITE, resolveHubService } from './auth/resolve';
import { boardStub } from './board/stub';
import { boardNamesById, cardLinksBody } from './card-links';
import { listBoards } from './db/catalog';
import { isRecordEvent } from './push/events';

/**
 * A service (Superlibrary) reading boards and cards, and registering a push config. Every answer
 * has the JSON the human route answers, so a consumer sees one shape whoever asks. The tenant comes
 * from the service token, so a board in another tenant is simply not found.
 */
const READS = /^\/v1\/boards(?:\/(brd_[0-9a-f]{16})(?:\/cards\/(card_[0-9a-f]{16})(?:\/(attempts|comments|links|activities))?)?)?$/;
const PUSH = /^\/v1\/boards\/(brd_[0-9a-f]{16})\/push-configs$/;

/** Decoded without verifying, only to route: resolveHubService verifies before anything is read. */
function looksLikeService(request: Request): boolean {
  const m = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+([^.\s]+)\.([^.\s]+)\.[^.\s]+$/);
  if (!m) return false;
  try {
    const b64 = m[2]!.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))).principalKind === 'service';
  } catch {
    return false;
  }
}

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });
const notFound = (what: string) => Response.json({ error: `${what} not found` }, { status: 404 });

export async function serviceRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  const read = request.method === 'GET' ? READS.exec(path) : null;
  const push = request.method === 'POST' ? PUSH.exec(path) : null;
  if ((!read && !push) || !looksLikeService(request)) return null;

  const svc = await resolveHubService(request, env);
  if (!svc) return refuse(401, 'UNAUTHORIZED', 'a service token for a mapped workspace is required');

  if (read) {
    if (!svc.scopes.includes(CARDS_READ)) return refuse(403, 'FORBIDDEN', 'this principal does not hold cards:read');
    const [, boardId, cardId, sub] = read;
    if (!boardId) return Response.json({ boards: await listBoards(env.DB, svc.tenantId) });
    if (!(await boardNamesById(env.DB, svc.tenantId, [boardId])).has(boardId)) return notFound('board');
    const stub = boardStub(env, svc.tenantId, boardId);
    if (!cardId) {
      const snapshot = await stub.getState();
      return snapshot.boardId ? Response.json(snapshot) : notFound('board');
    }
    if (!sub) {
      const r = await stub.getCardView(cardId);
      return r.ok ? Response.json({ card: r.value }) : Response.json({ error: r }, { status: 404 });
    }
    if (sub === 'attempts') return Response.json({ attempts: await stub.getAttempts(cardId) });
    if (sub === 'links') return Response.json(await cardLinksBody(env, svc.tenantId, stub, cardId));
    if (sub === 'activities') return Response.json(await stub.getCardActivities(cardId));
    const c = await stub.listComments(cardId);
    return c.ok ? Response.json({ comments: c.value }) : Response.json({ error: c }, { status: 404 });
  }

  if (!svc.scopes.includes(PUSH_WRITE)) return refuse(403, 'FORBIDDEN', 'this principal does not hold push:write');
  const boardId = push![1]!;
  if (!(await boardNamesById(env.DB, svc.tenantId, [boardId])).has(boardId)) return notFound('board');
  const body = (await request.json().catch(() => null)) as { url?: unknown; token?: unknown; events?: unknown } | null;
  if (
    !body || typeof body.url !== 'string' || typeof body.token !== 'string' || body.token === '' ||
    !Array.isArray(body.events) || body.events.length === 0 ||
    !body.events.every((e): e is string => typeof e === 'string' && isRecordEvent(e))
  ) {
    return refuse(400, 'INVALID_BODY', 'url, token and record events are required');
  }
  const result = await boardStub(env, svc.tenantId, boardId).registerPushConfig({
    agentId: `svc:${svc.principalId}`,
    url: body.url,
    token: body.token,
    events: body.events,
  });
  return result.ok ? Response.json(result.value, { status: 201 }) : Response.json({ error: result }, { status: 400 });
}

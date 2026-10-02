import { countAgentQueuesSince } from '../db/catalog';
import type { AgentPrincipal } from './resolve';

/**
 * May this agent put a card on this board, and on whose authority?
 *
 * Creating a card is the only agent act that spends OTHER agents' time, which is why it is its own
 * scope (`queue`) and why holding the scope is not the end of the question. Four things bound it,
 * and each is refused by name so a coordinator can report what it was stopped by instead of
 * guessing:
 *
 *   - the board must be one the operator named (`agents.may_queue_to_json`)
 *   - a human must be answerable for the card (`agents.owner_user_id`)
 *   - the agent must hold a dispatch grant, and it becomes the card's `queued_grant`
 *   - it must be inside the hourly ceiling (`agents.queue_ceiling_per_hour`)
 *
 * The grant is the whole safety model and needs no new machinery: an agent may queue work only for
 * principals it is itself permitted to dispatch. An agent granted dispatch over the Planning cast
 * can queue work for exactly them; an agent granted nothing can queue nothing that runs.
 *
 * Every refusal here happens at CREATION rather than at claim time. That is the point. A card
 * created with a null grant is refused by the control pair when an agent tries to claim it — so it
 * sits on the board looking queued, and is dead. This estate has hit that failure repeatedly, and
 * it is much worse than an error at the moment of asking.
 */
export type AgentQueueVerdict =
  | { ok: true; ownerUserId: string; queuedBy: string; queuedGrant: string[] }
  | { ok: false; status: number; code: string; message: string };

/** How far back the ceiling looks. A moving hour, so an agent recovers as it rolls. */
const WINDOW_MS = 60 * 60 * 1000;

export async function authorizeAgentQueue(
  db: D1Database,
  agent: AgentPrincipal,
  boardId: string,
  requestedOwnerUserId?: string,
): Promise<AgentQueueVerdict> {
  const policy = agent.queueing;
  if (!policy) {
    // The dev-header path reads no catalog row, so there is no policy to check and nothing that
    // could be checked later either. Refusing is the only honest answer.
    return {
      ok: false,
      status: 403,
      code: 'AGENT_QUEUE_POLICY_UNKNOWN',
      message: 'this credential resolves no agent record, so nothing bounds what it may queue',
    };
  }

  // Null is NOT "every board". An agent that gains the scope without the operator naming a board
  // must be able to create exactly zero cards.
  if (policy.mayQueueTo === null || !policy.mayQueueTo.includes(boardId)) {
    return {
      ok: false,
      status: 403,
      code: 'BOARD_NOT_PERMITTED',
      message: 'this agent is not permitted to queue work onto this board',
    };
  }

  if (!policy.ownerUserId) {
    return {
      ok: false,
      status: 403,
      code: 'AGENT_HAS_NO_OWNER',
      message: 'this agent has no owner, so there is nobody to be answerable for the card',
    };
  }

  // An agent queues on its own behalf, for its owner. It may not hand a card to somebody else.
  if (requestedOwnerUserId !== undefined && requestedOwnerUserId !== policy.ownerUserId) {
    return {
      ok: false,
      status: 403,
      code: 'AGENT_CANNOT_SET_OWNER',
      message: 'an agent may not name another user as a card\'s owner',
    };
  }

  // Absent and empty are different, and conflating them would either invent authority or report a
  // decision nobody made. Absent means this credential cannot speak to the question — a `spa_`
  // token, or an issuer that does not send the claim. Empty means somebody looked and said no.
  if (agent.mayDispatch === undefined) {
    return {
      ok: false,
      status: 403,
      code: 'DISPATCH_GRANT_UNKNOWN',
      message:
        'this credential carries no dispatch grant, so the authority for the card cannot be recorded; queueing needs a hub-issued agent token',
    };
  }
  if (agent.mayDispatch.length === 0) {
    return {
      ok: false,
      status: 403,
      code: 'NO_DISPATCH_AUTHORITY',
      message: 'this agent may dispatch nobody, so any card it queued could never be claimed',
    };
  }

  // Last, because it is the only check that reads the database.
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const recent = await countAgentQueuesSince(db, agent.agentId!, since);
  if (recent >= policy.queueCeilingPerHour) {
    return {
      ok: false,
      status: 429,
      code: 'QUEUE_CEILING_REACHED',
      message: `this agent has queued ${recent} cards in the last hour, at its ceiling of ${policy.queueCeilingPerHour}`,
    };
  }

  return {
    ok: true,
    ownerUserId: policy.ownerUserId,
    // The principal, not the local id: this is what the control pair checks, and it is the vocabulary
    // a grant is written in. Falls back to the local id only when the agent was never mapped, where
    // no grant could name it anyway.
    queuedBy: agent.externalId ?? agent.agentId!,
    queuedGrant: agent.mayDispatch,
  };
}

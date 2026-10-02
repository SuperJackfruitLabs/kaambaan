import type { AgentSummary, Card, Member } from '../../api';
import { agentForPrincipal, displayPrincipal, shortId } from '../../names';

/**
 * Who asked for this card, and on what authority.
 *
 * A card has three identities and the board rendered two of them:
 *
 *     ownerUserId       who is answerable for the card        -> rendered
 *     queuedBy          who authorised its dispatch           -> NOT rendered
 *     delegateAgentId   which agent is working it now          -> rendered
 *
 * `queuedBy` has been carried on every card since the control pair shipped, is deliberately
 * preserved when ownership is reassigned — "who is answerable for a card and who authorised its
 * dispatch are different questions" — and then appeared nowhere a person could see. That gap was
 * survivable while every card was queued by the same human. It stops being survivable the moment an
 * agent can queue work, because "an agent asked for this" and "the operator asked for this" must
 * be distinguishable at a glance or the audit trail credits the operator with work they never
 * requested.
 *
 * One module, used by the tile AND the drawer, because the alternative is the failure this
 * codebase already catalogued once: a lookup "copied once and forgotten five times".
 */
export interface CardProvenance {
  /** Is there anything to show? False on a card created before `queued_by` existed. */
  known: boolean;
  /** The queuer, as a name — a member's, an agent's, or a short id. Never a bare `prn_…`. */
  queuedByName: string;
  /**
   * Did an AGENT queue this? Read from `queuedByAgentId`, which the card stores rather than
   * derives, so a deleted or renamed agent cannot turn an agent-queued card back into a human one.
   */
  byAgent: boolean;
  /** The queueing agent's row, for its avatar and colour. Null when an agent queued it but the row is gone. */
  agent: AgentSummary | null;
  /**
   * How many principals the queuer was permitted to dispatch when they queued it.
   *
   * Null and 0 are different and both are kept: null is "no authority was captured", 0 is
   * "somebody decided nobody". Both refuse a claim under enforcement; they are different facts
   * about why, and a card carrying a 55-principal grant is a very different object from one
   * carrying three.
   */
  grantSize: number | null;
  /**
   * Could the queuer dispatch the agent that ended up working this card?
   *
   * Null when nothing holds the card yet, and null when the agent holding it was never mapped to a
   * principal — in both cases the question has no answer, and a `false` would render as a warning
   * about a card that has done nothing wrong. `false` is the genuinely interesting state: under
   * enforcement it should be unreachable, so seeing it means enforcement is off or the grant was
   * narrowed after the claim.
   */
  grantCoversDelegate: boolean | null;
}

export function cardProvenance(card: Card, members: Member[], agents: AgentSummary[]): CardProvenance {
  const byAgent = !!card.queuedByAgentId;
  const agent = byAgent
    ? agents.find((a) => a.id === card.queuedByAgentId) ?? agentForPrincipal(card.queuedBy, agents) ?? null
    : null;

  // `displayPrincipal` is given the agents list so an agent principal resolves to its name; it
  // falls back to a short id, which is honest where inventing a name would not be.
  const queuedByName = card.queuedBy ? agent?.name?.trim() || displayPrincipal(card.queuedBy, members, agents) : '';

  const grant = card.queuedGrant ?? null;
  const delegate = card.delegateAgentId ? agents.find((a) => a.id === card.delegateAgentId) ?? null : null;
  const delegatePrincipal = delegate?.externalId ?? null;

  return {
    known: !!card.queuedBy,
    queuedByName: queuedByName || (card.queuedBy ? shortId(card.queuedBy) : ''),
    byAgent,
    agent,
    grantSize: grant === null ? null : grant.length,
    grantCoversDelegate:
      grant === null || delegatePrincipal === null ? null : grant.includes(delegatePrincipal),
  };
}

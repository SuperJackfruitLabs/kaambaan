/**
 * Ids, shown as names.
 *
 * The board printed `agt_2613e473e3934509` in six places where it already knew the agent was
 * called research-ray: a run's header, an attempt, an elicitation, a tile's answer button, the
 * needs-you list. A seventh — Spend — resolved the name correctly with a one-line `find()`.
 *
 * So the data was never missing; the lookup was copied once and forgotten five times. One
 * function, used everywhere, is the difference between that and a rule.
 */
import type { AgentSummary, Member } from './api';

/**
 * `agt_2613e473e3934509` → `agt_…934509`.
 *
 * The prefix stays because it says what KIND of thing the id names, and the tail stays because
 * that is the part that distinguishes two of them. A bare `…934509` would be unsearchable and an
 * `agt_2613…` would collide across a workspace whose ids share a generator.
 */
export function shortId(id: string): string {
  if (id.length <= 11) return id;
  const cut = id.indexOf('_');
  const prefix = cut > 0 ? id.slice(0, cut + 1) : '';
  return `${prefix}…${id.slice(-6)}`;
}

/**
 * An agent's name, or a short id when the workspace cannot name it.
 *
 * Never empty for a non-empty id: the agents list can lag a card, and a card can name an agent
 * that has since been deleted. A blank where the worker's name goes is worse than the id this
 * exists to replace.
 */
export function displayAgent(agentId: string | null | undefined, agents: AgentSummary[]): string {
  if (!agentId) return '';
  const name = agents.find((a) => a.id === agentId)?.name?.trim();
  return name || shortId(agentId);
}

/**
 * A person's name, an AGENT's name, an email, or a short id.
 *
 * A principal is not always a person. A card queued by a coordinator records that agent's
 * `prn_…` — and `queued by prn_d8178f4a…` is precisely the id-instead-of-a-name this module
 * exists to stop. The agents list already carries the same `externalId`, so the lookup is here
 * rather than in the one component that noticed.
 *
 * `agents` is optional so the six existing call sites keep their exact behaviour: a gate decided
 * through AgentPod by a PERSON records a `prn_…` whose directory lives in another product, and
 * shortening it is honest where inventing a name would not be.
 */
export function displayPrincipal(
  userId: string | null | undefined,
  members: Member[],
  agents?: AgentSummary[],
): string {
  if (!userId) return '';
  const m = members.find((x) => x.userId === userId);
  const name = m?.name?.trim();
  if (name) return name;
  if (m?.email) return m.email;
  // A member first: the two id spaces never overlap, so order is about cost rather than ambiguity.
  // The `!!a.externalId` guard matters — an unmapped agent carries null, and a loose comparison
  // would match a null principal to the first unmapped agent in the workspace.
  const agentName = agents?.find((a) => !!a.externalId && a.externalId === userId)?.name?.trim();
  if (agentName) return agentName;
  return shortId(userId);
}

/**
 * The agent behind a principal id, when one is behind it.
 *
 * Separate from `displayPrincipal` because the callers want different things from the same lookup:
 * a name to print, or the agent row itself — for its avatar, its colour, and for the one fact that
 * cannot be derived from a name at all, which is that an agent is there.
 */
export function agentForPrincipal(
  principalId: string | null | undefined,
  agents: AgentSummary[],
): AgentSummary | null {
  if (!principalId) return null;
  return agents.find((a) => !!a.externalId && a.externalId === principalId) ?? null;
}

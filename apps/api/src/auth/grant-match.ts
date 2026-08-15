/**
 * Matching a namespaced grant value against an agent of this plane.
 *
 * The rules are the fixture's, not ours: `fixtures/ecosystem-identity/token_claims.json`
 * in AgentPod pins them, and this is kaambaan's implementation of the same
 * contract. They are duplicated in behaviour and shared in specification, which
 * is the arrangement that has kept five hand-written Go mirrors honest.
 *
 * charter → decisions/2026-08-15-a-grant-names-an-agent-per-plane.md
 */

/** The namespace this plane answers for. */
export const KAAMBAAN_NS = 'kaambaan:';

/**
 * Does one grant value permit dispatching this agent?
 *
 * A value in another plane's namespace is **ignored, never denied** — a plane
 * that refused what it did not understand would break the day a third plane
 * appeared, and a claim is read by more planes over time, not fewer.
 *
 * An **unprefixed** value matches nothing. That was AgentPod's retired
 * `CONTROL_PAIR_GRANTS` format; honouring it here would mean a half-migrated
 * suite enforcing two different rules depending on which plane read the grant.
 */
export function valuePermitsAgent(value: string, agentId: string): boolean {
  if (!value.startsWith(KAAMBAAN_NS)) return false;
  const target = value.slice(KAAMBAAN_NS.length);

  if (target === agentId) return true;
  if (!target.endsWith('*')) return false;
  return agentId.startsWith(target.slice(0, -1));
}

/**
 * May this grant dispatch this agent?
 *
 * `null` is "no grant was recorded", which is not the same as an empty one and
 * is refused just the same: nobody with authority ever asked for this work to
 * run. An empty array is a decision, and the decision is no.
 */
export function grantPermitsAgent(grant: string[] | null, agentId: string): boolean {
  if (!grant) return false;
  return grant.some((v) => valuePermitsAgent(v, agentId));
}

/** Is the control pair enforced here? Literal lowercase "true", as everywhere else in this suite. */
export function isControlPairEnforced(env: { ENFORCE_CONTROL_PAIR?: string }): boolean {
  return env.ENFORCE_CONTROL_PAIR === 'true';
}

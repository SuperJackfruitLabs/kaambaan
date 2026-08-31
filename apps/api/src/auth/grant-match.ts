/**
 * Matching a grant value against the principal a dispatch would run as.
 *
 * The rule is the fixture's, not ours: `fixtures/ecosystem-identity/token_claims.json` in
 * AgentPod pins it, and this is kaambaan's hand-written implementation of the same contract —
 * duplicated in behaviour and shared in specification, which is the arrangement that has kept
 * five hand-written Go mirrors honest.
 *
 * A grant now names one principal id and matches by EQUALITY — no per-plane namespace, no
 * wildcard. The `kaambaan:` prefix and `*` suffix this file used to implement were DELETED, not
 * deprecated: `hermes:*` silently spanned nodes, and a namespaced wildcard grant once reached a
 * root station that should never have existed. A pattern matches things nobody intended; an
 * enumeration cannot.
 *
 * charter → decisions/2026-08-30-an-agent-is-a-principal.md §3
 */

/**
 * Does one grant value permit this principal?
 *
 * Equality only, character for character. `*` is not a wildcard here — it is a string that will
 * never equal a real `prn_…` id, so it simply fails to match rather than being read as "every
 * principal" or "every principal of this shape". A value from a retired or foreign scheme (a
 * `kaambaan:`-namespaced id, say) is not special-cased either: it is just a string, and it is not
 * equal to the id being checked, which is the same "ignore, never deny" outcome the fixture
 * requires without any namespace grammar to check it against.
 */
export function valuePermitsAgent(value: string, principalId: string): boolean {
  return value === principalId;
}

/**
 * May this grant dispatch this principal?
 *
 * `principalId` is the SUITE principal id the claiming agent maps to (`agents.external_id`,
 * charter decisions/2026-08-30-an-agent-is-a-principal.md §5) — not kaambaan's local `agt_…` id,
 * which no external grant can ever name. `null` means this local agent has never been linked to
 * a principal (the ordinary state for a standalone kaambaan, and for every agent before someone
 * records a mapping): no grant, however it reads, can cover an id that does not exist yet.
 *
 * `null` for `grant` is "no grant was recorded", which is not the same as an empty one and is
 * refused just the same: nobody with authority ever asked for this work to run. An empty array
 * is a decision, and the decision is no.
 */
export function grantPermitsAgent(grant: string[] | null, principalId: string | null): boolean {
  if (!grant || principalId === null) return false;
  return grant.some((v) => valuePermitsAgent(v, principalId));
}

/** Is the control pair enforced here? Literal lowercase "true", as everywhere else in this suite. */
export function isControlPairEnforced(env: { ENFORCE_CONTROL_PAIR?: string }): boolean {
  return env.ENFORCE_CONTROL_PAIR === 'true';
}

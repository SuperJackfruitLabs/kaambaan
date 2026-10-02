/**
 * What a `spa_` agent token is allowed to do — the vocabulary, shared.
 *
 * The *enforcement* lives in `apps/api/src/auth/scopes.ts`, next to the routes it guards, and
 * only the names live here. They are here because a second plane now has to say one: the console
 * mints a narrowed credential (`{"scopes":["run"]}`) for an agent that drives its own card over
 * MCP, and a console spelling a scope the API does not recognise would be refused at the far end
 * with nothing in either codebase connecting the two spellings.
 *
 * Four scopes, in two pairs.
 *
 * What a WORKER does to the card it holds:
 *
 * - `claim` — take a card off the board (`POST …/claims`).
 * - `run`   — drive a claimed card (`GET/POST …/runs/*`) and the MCP tools that wrap those verbs.
 *
 * What a COORDINATOR does to the board itself:
 *
 * - `read`  — list boards, read a board, read a card.
 * - `queue` — create a card.
 *
 * The second pair is separate from the first, and separate from each other, because they are
 * different kinds of trust. A worker needs neither. A verifier wants `read` and must never have
 * `queue`. And `queue` is the only agent scope that spends other agents' time, which is why it is
 * its own grant and why it is bounded by the queuer's own `mayDispatch` rather than by a flag.
 */
export type AgentScope = 'claim' | 'run' | 'read' | 'queue';

/**
 * What a freshly minted agent token carries when the caller asks for nothing narrower.
 *
 * Deliberately NOT widened when `read` and `queue` were added. Every existing mint site passes
 * this unchanged, so a fleet of worker agents gains nothing from the new vocabulary — a
 * coordinator's credential has to be asked for by name.
 */
export const AGENT_TOKEN_SCOPES: AgentScope[] = ['claim', 'run'];

/** Is this an agent scope, whatever a caller sent? The one place that decides. */
export function isAgentScope(value: unknown): value is AgentScope {
  return value === 'claim' || value === 'run' || value === 'read' || value === 'queue';
}

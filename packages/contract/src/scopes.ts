/**
 * What a `spa_` agent token is allowed to do — the vocabulary, shared.
 *
 * The *enforcement* lives in `apps/api/src/auth/scopes.ts`, next to the routes it guards, and
 * only the names live here. They are here because a second plane now has to say one: the console
 * mints a narrowed credential (`{"scopes":["run"]}`) for an agent that drives its own card over
 * MCP, and a console spelling a scope the API does not recognise would be refused at the far end
 * with nothing in either codebase connecting the two spellings.
 *
 * Two scopes, because there are two things an agent does:
 *
 * - `claim` — take a card off the board (`POST …/claims`).
 * - `run`   — drive a claimed card (`GET/POST …/runs/*`) and the MCP tools that wrap those verbs.
 */
export type AgentScope = 'claim' | 'run';

/** What a freshly minted agent token carries when the caller asks for nothing narrower. */
export const AGENT_TOKEN_SCOPES: AgentScope[] = ['claim', 'run'];

/** Is this an agent scope, whatever a caller sent? The one place that decides. */
export function isAgentScope(value: unknown): value is AgentScope {
  return value === 'claim' || value === 'run';
}

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
 * - `read`  — the read surface: boards, cards, projects, milestones, labels, capabilities, agents.
 * - `queue` — create a card.
 * - `plan`  — rearrange work that already exists: projects, milestones, a card's own fields, which
 *             stage it sits in, and the links between cards.
 * - `compose` — make a PLACE for work, and write the runbook for doing it: create a board, and set a
 *             stage's `instructions`. Not routing on a board that already has cards: a new board is
 *             empty, so bad routing there strands nothing, while changing a live stage re-routes
 *             every card on it. Its own scope rather than part of `plan` because most planners should
 *             not create boards, and the agent who should write runbooks needs neither card edits nor
 *             moves to do it.
 *
 * These are separate from the worker pair, and separate from each other, because they are different
 * kinds of trust. A worker needs none of them. A verifier wants `read` and must never have the
 * others. `queue` is the only agent scope that SPENDS other agents' time, which is why it is bounded
 * by the queuer's own `mayDispatch` rather than by a flag. `plan` spends nobody's time — it
 * rearranges — with one exception that is handled where it arises rather than here: moving a card
 * into a dispatchable stage IS dispatching it, so that one act carries the same grant check a create
 * does (`auth/agent-queue.ts`).
 *
 * Deliberately NOT in this list: resolving a gate. That is the human half of the control pair, and
 * an agent holding both halves makes every "a human decided this" record unverifiable — including
 * the record of that agent's own work.
 */
export type AgentScope = 'claim' | 'run' | 'read' | 'queue' | 'plan' | 'compose';

/**
 * What a freshly minted agent token carries when the caller asks for nothing narrower.
 *
 * Deliberately NOT widened when `read`, `queue`, `plan` and `compose` were added. Every existing mint site
 * passes this unchanged, so a fleet of worker agents gains nothing from the new vocabulary — a
 * coordinator's credential has to be asked for by name.
 */
export const AGENT_TOKEN_SCOPES: AgentScope[] = ['claim', 'run'];

/** Is this an agent scope, whatever a caller sent? The one place that decides. */
export function isAgentScope(value: unknown): value is AgentScope {
  return (
    value === 'claim' ||
    value === 'run' ||
    value === 'read' ||
    value === 'queue' ||
    value === 'plan' ||
    value === 'compose'
  );
}

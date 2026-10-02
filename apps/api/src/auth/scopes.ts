import type { AgentScope } from '@superpipeline/contract';

/**
 * What a `spa_` token is allowed to do.
 *
 * Scopes have been minted onto every agent token since migration 0001 (`scopes_json`), returned by
 * the resolver, and compared to nothing: a token minted with `['claim']` drove every run verb and
 * every MCP tool. An authorization field that is recorded and never checked reads as protection
 * that does not exist, which is worse than no field, so this is where the comparison lives.
 *
 * The two scope NAMES live in `@superpipeline/contract`, because the console mints with them too
 * and two spellings of one word is a refusal with nothing to trace it to. What they permit is
 * here, next to the routes it guards:
 *
 * - `claim` — take a card off the board (`POST …/claims`).
 * - `run`   — drive a claimed card (`GET/POST …/runs/*`) and the MCP tools that wrap those verbs.
 *
 * **`claim` grandfathers `run`, deliberately.** Every token minted before this file existed holds
 * `['claim']` alone, and those agents are running now. Enforcing the split literally would let
 * them claim a card and then be refused every verb that finishes it — a card taken and abandoned
 * mid-flight, which is strictly worse for the board than the unchecked scope was. A claim an agent
 * cannot complete is not a safer claim. New tokens carry both explicitly, so the grandfather
 * clause ages out on its own as tokens are reissued.
 *
 * **It does not cover verbs that CREATE work.** The argument above is entirely about finishing, and
 * a verb that makes new cards is not finishing anything — a `['claim']` token inheriting it would
 * hold an authority the argument never reached and whoever minted the token never granted. Those
 * verbs are named in `CREATES_WORK` (`mcp/tools.ts`) and pass `grandfather: false` below.
 *
 * That exemption exists for the slope more than for today's single member: without it, every `run`
 * verb added from here on inherits to legacy tokens by default, and the next person adding one
 * reads the paragraph above as covering it.
 */
export { AGENT_TOKEN_SCOPES, isAgentScope, type AgentScope } from '@superpipeline/contract';

/**
 * Refused outright: the route is reachable by an agent on SOME method and not on this one.
 *
 * A distinct value rather than `null`, because `null` means "not scope-gated" and is a pass. The
 * two must not be spelled the same: `GET /v1/boards/:id` is a `read` and `DELETE` on that exact
 * path destroys the board and everything it held, and a gate that returned `null` for the method
 * it had no opinion about would have let the second through on the strength of the first.
 */
export const SCOPE_FORBIDDEN = '__forbidden__' as const;
export type ScopeVerdict = AgentScope | typeof SCOPE_FORBIDDEN | null;

/**
 * The scope a board route requires, `SCOPE_FORBIDDEN`, or null when it is not scope-gated.
 *
 * `rest` is the path beneath `/v1/boards/:id/`, exactly as the Worker computes it, and `method`
 * is the request's. The method is part of the gate and not a detail: an agent reaching a path is
 * never the same question as what it may do there.
 */
export function requiredScope(
  rest: string,
  method: string,
  opts?: {
    /**
     * Whether the path named a board. `rest` is empty for BOTH `/v1/boards` and `/v1/boards/:id`, so
     * without this the create route and the board read are indistinguishable — and they are a
     * `compose` and a `read`.
     *
     * Defaults to true, which is the board-scoped reading every existing caller meant.
     */
    hasBoardId?: boolean;
  },
): ScopeVerdict {
  if (opts?.hasBoardId === false) {
    // `/v1/boards` itself: list them, or make one.
    if (method === 'GET') return 'read';
    if (method === 'POST') return 'compose';
    return SCOPE_FORBIDDEN;
  }
  if (rest === 'claims') return 'claim';
  if (rest.startsWith('runs/')) return 'run';

  // The BOARD itself: readable, never edited or deleted by an agent. Renaming a board and deleting
  // one are both `manage`/`admin` acts for a person; neither is a coordinator's.
  if (rest === '') {
    return method === 'GET' ? 'read' : SCOPE_FORBIDDEN;
  }
  // ONE card. Read on `read`, edited on `plan`, and never deleted — the same path answering three
  // different questions, which is why the method is part of the gate.
  if (/^cards\/[^/]+$/.test(rest)) {
    if (method === 'GET') return 'read';
    if (method === 'PATCH') return 'plan';
    return SCOPE_FORBIDDEN;
  }
  // `cards` serves POST and nothing else — there is no card-LIST route in this product, for anyone:
  // the board snapshot IS the list, and a `read` token already fetches it. Recorded because the
  // first draft of this claimed a `GET` no handler serves, which would have refused an agent on a
  // scope for a route that answers 405 to everybody.
  if (rest === 'cards') {
    // Creating a card is the one act that spends other agents' time, and it is its own scope. What
    // bounds it is not this function but the queuer's own `mayDispatch`, recorded on the card.
    return method === 'POST' ? 'queue' : SCOPE_FORBIDDEN;
  }
  if (/^cards\/[^/]+\/(activities|attempts|estimate)$/.test(rest)) {
    return method === 'GET' ? 'read' : SCOPE_FORBIDDEN;
  }
  /**
   * Moving a card between stages. `plan`, but NOT only `plan`.
   *
   * A move into a dispatchable stage IS a dispatch — `moveCard` stamps `queued_by` and
   * `queued_grant`, because "whoever moves a card into a dispatchable stage is the one dispatching
   * it now". So the route also puts an agent mover through `authorizeAgentQueue`, the same board
   * allowlist, owner, grant and hourly ceiling a create passes. The scope says who may rearrange;
   * the grant says on whose authority. Without the second, an agent could launder a human's grant
   * onto work it chose itself.
   */
  if (/^cards\/[^/]+\/move$/.test(rest)) {
    return method === 'POST' ? 'plan' : SCOPE_FORBIDDEN;
  }
  // Edges between cards — "this waits on that" is a coordinator's main tool for saying what order
  // work happens in, and it is the mechanism behind raising a decision that must block something.
  if (rest === 'links') {
    return method === 'POST' || method === 'DELETE' ? 'plan' : SCOPE_FORBIDDEN;
  }
  /**
   * Deciding a gate: refused on every scope, and this is the one refusal here that is a product
   * boundary rather than a scoping choice.
   *
   * It is the human half of the control pair. An agent that holds both halves makes every "a human
   * decided this" record in the estate unverifiable — including the record of that agent's own work.
   * A coordinator RAISES decisions instead, as cards (spec 2026-10-02-a-coordinator-plans-the-work).
   */
  if (/^gates\/[^/]+\/resolve$/.test(rest)) return SCOPE_FORBIDDEN;
  /**
   * Stages. ONE stage's prose is composable; the pipeline is not.
   *
   * `PATCH stages/:key` is reached on `compose` and then authorised FIELD by field
   * (`stagePatchRefusal`): `instructions` is prose handed to whoever claims there, and getting it
   * wrong is bad work — visible in a handoff, recoverable, one card at a time. `owner`, `requires`,
   * `order`, `gate` and `wipLimit` are ROUTING, and getting those wrong strands every card in the
   * lane silently, which a terminal stage nobody could act on did to seven live cards.
   *
   * `POST stages` replaces the whole pipeline and stays refused: it is the same hazard wholesale, and
   * it has already destroyed stage instructions once.
   */
  if (/^stages\/[^/]+$/.test(rest)) {
    return method === 'PATCH' ? 'compose' : SCOPE_FORBIDDEN;
  }
  if (rest === 'stages' || rest.startsWith('stages/')) return SCOPE_FORBIDDEN;

  // `gates/pending` is routed as an agent route but names nobody and carries no authority — a read
  // the hub's reconciliation sweep makes. It is not gated on a scope for the same reason it is not
  // gated on an agent identity.
  return null;
}

/**
 * Does this token's scope set permit `needed`?
 *
 * A `null` scope set means the credential did not come from `agent_tokens` at all — a hub-issued
 * agent token, whose authority is the hub's and is checked by the control pair at claim time, or a
 * dev header. Those are unaffected: this function answers about `spa_` tokens only.
 */
export function scopePermits(
  scopes: string[] | null | undefined,
  needed: AgentScope,
  opts?: { grandfather?: boolean },
): boolean {
  if (!scopes) return true;
  if (scopes.includes(needed)) return true;
  // The grandfather clause above, and the one thing it was never an argument for.
  //
  // Its whole case is about FINISHING — "a claim an agent cannot complete is not a safer claim".
  // A verb that CREATES work is the opposite, so a caller that knows it is gating one passes
  // `grandfather: false` and a legacy `['claim']` token is refused it. The rule for membership is
  // one line and belongs with the verbs, not here: see `CREATES_WORK` in `mcp/tools.ts`.
  if (opts?.grandfather === false) return false;
  return needed === 'run' && scopes.includes('claim');
}

/**
 * Which fields of a stage PATCH an agent may send, and which it may not.
 *
 * **The first field-level authorisation in this codebase**, and recorded as a precedent rather than
 * slipped in: every other scope gates a route and a method, so a reviewer should know that a scope
 * can now permit a route and still refuse a body.
 *
 * It exists because one route carries two different kinds of power. `instructions` is the prose an
 * agent is handed when it claims the stage — wrong prose is bad work, which shows up in a handoff and
 * costs one card. Everything else is routing, and wrong routing strands every card in the lane with
 * nothing to see.
 *
 * Returns null when the body is allowed, or a sentence NAMING the offending field — a caller that
 * sends `owner` should learn which key was the problem, not that the route is shut.
 */
const COMPOSABLE_STAGE_FIELDS = new Set(['instructions']);

export function stagePatchRefusal(body: Record<string, unknown>): string | null {
  const sent = Object.keys(body);
  if (sent.length === 0) {
    return 'nothing to change: send instructions';
  }
  const refused = sent.filter((k) => !COMPOSABLE_STAGE_FIELDS.has(k));
  if (refused.length > 0) {
    return `an agent may only set a stage's instructions; refused: ${refused.join(', ')}`;
  }
  return null;
}

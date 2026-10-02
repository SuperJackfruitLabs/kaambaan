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
export function requiredScope(rest: string, method: string): ScopeVerdict {
  if (rest === 'claims') return 'claim';
  if (rest.startsWith('runs/')) return 'run';

  // The board itself, and one card: readable by a coordinator, never editable or deletable.
  if (rest === '' || /^cards\/[^/]+$/.test(rest)) {
    return method === 'GET' ? 'read' : SCOPE_FORBIDDEN;
  }
  // Creating a card is the one write an agent gets, and it is its own scope. What bounds it is
  // not this function but the queuer's own `mayDispatch`, recorded on the card.
  if (rest === 'cards') {
    return method === 'POST' ? 'queue' : SCOPE_FORBIDDEN;
  }

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

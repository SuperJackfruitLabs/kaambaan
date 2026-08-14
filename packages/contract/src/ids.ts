import { z } from 'zod';

/**
 * Prefixed, opaque identifiers. Each id is `<prefix>_<base62 token>` so the entity type is
 * legible at a glance and mis-wired ids fail validation early.
 */
const idSchema = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9]{6,}$`), `expected a "${prefix}_…" id`);

/**
 * `tnt` stays `tnt`. The tenant is now explicitly kaambaan's *local* isolation boundary rather
 * than an org (docs/01), which raises the question of renaming the prefix — and the answer is no.
 * `tnt` is registered to kaambaan as `declared-and-minted` in the shared fixture corpus
 * (AgentPod `fixtures/ecosystem-identity/id_grammar.json`), with accept/reject cases another
 * repo's suite asserts against; renaming would be a coordinated two-repo change that buys no
 * correctness. Collision safety comes from the registry, not from the spelling: AgentPod's own
 * local boundary must claim a *different* prefix, exactly as `run_`/`attempt_` was settled — the
 * side with no rows moves, and here that is AgentPod's, which does not exist yet.
 */
export const TenantId = idSchema('tnt');
export const UserId = idSchema('usr');
// `mbr`, not `mem`: this is what the API mints (`newId('mbr')`) and what exists in D1 today.
export const MembershipId = idSchema('mbr');
export const BoardId = idSchema('brd');
export const AgentId = idSchema('agt');
export const TokenId = idSchema('tok');
export const CardId = idSchema('card');
export const TaskId = idSchema('task');
export const RunId = idSchema('run');
export const ReferenceId = idSchema('ref');
export const GateId = idSchema('gate');
/** An agent's open question to a human (docs/04 §4) — the thing an answer is addressed to. */
export const ElicitationId = idSchema('elc');
export const EventId = idSchema('evt');
export const ContextId = idSchema('ctx');

export const ID_PREFIXES = {
  tenant: 'tnt',
  user: 'usr',
  membership: 'mbr',
  board: 'brd',
  agent: 'agt',
  token: 'tok',
  card: 'card',
  task: 'task',
  run: 'run',
  reference: 'ref',
  gate: 'gate',
  elicitation: 'elc',
  event: 'evt',
  context: 'ctx',
} as const;

import { z } from 'zod';

/**
 * Prefixed, opaque identifiers. Each id is `<prefix>_<base62 token>` so the entity type is
 * legible at a glance and mis-wired ids fail validation early.
 */
const idSchema = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9]{6,}$`), `expected a "${prefix}_…" id`);

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
  event: 'evt',
  context: 'ctx',
} as const;
